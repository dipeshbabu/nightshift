#!/bin/bash
#
# Set up automated start/stop scheduling for the nightshift-dev EC2 instance.
#
# Creates:
#   - Elastic IP (stable address across stop/start cycles)
#   - IAM role + policy for Lambda (ec2:Start/Stop/Describe + CloudWatch Logs)
#   - Lambda functions: nightshift-start, nightshift-stop
#   - IAM role + policy for EventBridge Scheduler (lambda:InvokeFunction)
#   - EventBridge Schedules: start 8am ET Mon-Fri, stop midnight ET Tue-Sat
#
# Prerequisites:
#   - infra/dev/.instance must exist (run setup.sh first)
#   - AWS CLI configured with appropriate permissions
#
# Usage: ./infra/dev/cron.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="$SCRIPT_DIR/.instance"

if [ ! -f "$STATE_FILE" ]; then
    echo "ERROR: No instance found. Run setup.sh first."
    exit 1
fi

source "$STATE_FILE"

ACCOUNT_ID=$(aws sts get-caller-identity --query 'Account' --output text)

echo "==> Nightshift cron setup"
echo "    Instance: $INSTANCE_ID"
echo "    Region: $REGION"
echo "    Account: $ACCOUNT_ID"
echo ""

#
# A normal EC2 public IP changes every stop/start cycle. An Elastic IP stays
# fixed, so SSH config and .instance don't need updating after each restart.

# Check if instance already has an Elastic IP
EXISTING_EIP=$(aws ec2 describe-addresses \
    --filters "Name=instance-id,Values=$INSTANCE_ID" \
    --region "$REGION" \
    --query 'Addresses[0].PublicIp' \
    --output text 2>/dev/null || echo "None")

if [ "$EXISTING_EIP" != "None" ] && [ -n "$EXISTING_EIP" ]; then
    echo "==> Elastic IP already associated: $EXISTING_EIP"
    EIP="$EXISTING_EIP"
else
    echo "==> Allocating Elastic IP..."
    ALLOC_ID=$(aws ec2 allocate-address \
        --domain vpc \
        --region "$REGION" \
        --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=nightshift-dev},{Key=Project,Value=nightshift}]" \
        --query 'AllocationId' \
        --output text)

    EIP=$(aws ec2 describe-addresses \
        --allocation-ids "$ALLOC_ID" \
        --region "$REGION" \
        --query 'Addresses[0].PublicIp' \
        --output text)

    echo "    Allocated: $EIP ($ALLOC_ID)"

    echo "==> Associating Elastic IP with instance..."
    aws ec2 associate-address \
        --instance-id "$INSTANCE_ID" \
        --allocation-id "$ALLOC_ID" \
        --region "$REGION" \
        --output text > /dev/null

    echo "    Associated"
fi

# Update .instance with the stable Elastic IP
cat > "$STATE_FILE" << EOF
INSTANCE_ID=$INSTANCE_ID
PUBLIC_IP=$EIP
KEY_PATH=~/.ssh/nightshift-dev.pem
REGION=$REGION
EOF
echo "    Updated $STATE_FILE with Elastic IP"

#
# Lambda needs an IAM role to assume at runtime. This role grants:
#   - ec2:StartInstances, ec2:StopInstances, ec2:DescribeInstances
#   - CloudWatch Logs (for Lambda's built-in logging)

LAMBDA_ROLE_NAME="nightshift-lambda-role"

LAMBDA_TRUST_POLICY='{
    "Version": "2012-10-17",
    "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "lambda.amazonaws.com"},
        "Action": "sts:AssumeRole"
    }]
}'

LAMBDA_EXEC_POLICY='{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "ec2:StartInstances",
                "ec2:StopInstances"
            ],
            "Resource": "arn:aws:ec2:*:*:instance/*",
            "Condition": {
                "StringEquals": {"aws:ResourceTag/Name": "nightshift-dev"}
            }
        },
        {
            "Effect": "Allow",
            "Action": "ec2:DescribeInstances",
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents"
            ],
            "Resource": "arn:aws:logs:*:*:*"
        }
    ]
}'

if aws iam get-role --role-name "$LAMBDA_ROLE_NAME" &>/dev/null; then
    echo "==> IAM role '$LAMBDA_ROLE_NAME' already exists"
    LAMBDA_ROLE_ARN=$(aws iam get-role \
        --role-name "$LAMBDA_ROLE_NAME" \
        --query 'Role.Arn' \
        --output text)
else
    echo "==> Creating IAM role: $LAMBDA_ROLE_NAME"
    LAMBDA_ROLE_ARN=$(aws iam create-role \
        --role-name "$LAMBDA_ROLE_NAME" \
        --assume-role-policy-document "$LAMBDA_TRUST_POLICY" \
        --query 'Role.Arn' \
        --output text)

    aws iam put-role-policy \
        --role-name "$LAMBDA_ROLE_NAME" \
        --policy-name "nightshift-lambda-policy" \
        --policy-document "$LAMBDA_EXEC_POLICY"

    echo "    Role ARN: $LAMBDA_ROLE_ARN"

    # IAM roles take a few seconds to propagate. Lambda create-function will
    # fail with "The role defined for the function cannot be assumed" if we
    # don't wait.
    echo "    Waiting for IAM propagation..."
    sleep 10
fi

#
# Each function is a single Python file zipped up. Lambda expects a zip with
# the handler file at the root level.

LAMBDA_DIR="$SCRIPT_DIR/lambda"

for FUNC in start stop; do
    FUNC_NAME="nightshift-${FUNC}"
    ZIP_FILE="/tmp/nightshift-${FUNC}.zip"

    # Zip the Python file (cd into the dir so the zip contains just the .py)
    (cd "$LAMBDA_DIR" && zip -j "$ZIP_FILE" "${FUNC}.py") > /dev/null

    if aws lambda get-function --function-name "$FUNC_NAME" --region "$REGION" &>/dev/null; then
        echo "==> Updating Lambda function: $FUNC_NAME"
        aws lambda update-function-code \
            --function-name "$FUNC_NAME" \
            --zip-file "fileb://$ZIP_FILE" \
            --region "$REGION" \
            --output text > /dev/null
    else
        echo "==> Creating Lambda function: $FUNC_NAME"
        aws lambda create-function \
            --function-name "$FUNC_NAME" \
            --runtime python3.12 \
            --role "$LAMBDA_ROLE_ARN" \
            --handler "${FUNC}.handler" \
            --zip-file "fileb://$ZIP_FILE" \
            --timeout 300 \
            --region "$REGION" \
            --output text > /dev/null
    fi

    rm -f "$ZIP_FILE"
    echo "    Deployed $FUNC_NAME"
done

# ── 4. EventBridge Scheduler IAM role ─────────────────────────────────────────
#
# EventBridge Scheduler needs its own role to invoke Lambda functions.
# This is separate from the Lambda execution role.

SCHEDULER_ROLE_NAME="nightshift-scheduler-role"

SCHEDULER_TRUST_POLICY='{
    "Version": "2012-10-17",
    "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "scheduler.amazonaws.com"},
        "Action": "sts:AssumeRole"
    }]
}'

SCHEDULER_POLICY="{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
        \"Effect\": \"Allow\",
        \"Action\": \"lambda:InvokeFunction\",
        \"Resource\": [
            \"arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:nightshift-start\",
            \"arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:nightshift-stop\"
        ]
    }]
}"

if aws iam get-role --role-name "$SCHEDULER_ROLE_NAME" &>/dev/null; then
    echo "==> IAM role '$SCHEDULER_ROLE_NAME' already exists"
    SCHEDULER_ROLE_ARN=$(aws iam get-role \
        --role-name "$SCHEDULER_ROLE_NAME" \
        --query 'Role.Arn' \
        --output text)
else
    echo "==> Creating IAM role: $SCHEDULER_ROLE_NAME"
    SCHEDULER_ROLE_ARN=$(aws iam create-role \
        --role-name "$SCHEDULER_ROLE_NAME" \
        --assume-role-policy-document "$SCHEDULER_TRUST_POLICY" \
        --query 'Role.Arn' \
        --output text)

    aws iam put-role-policy \
        --role-name "$SCHEDULER_ROLE_NAME" \
        --policy-name "nightshift-scheduler-policy" \
        --policy-document "$SCHEDULER_POLICY"

    echo "    Role ARN: $SCHEDULER_ROLE_ARN"
    echo "    Waiting for IAM propagation..."
    sleep 10
fi

#
# EventBridge Scheduler (not CloudWatch Events) supports timezone-aware cron.
# The timezone parameter handles DST automatically — no manual UTC offset math.
#
# Schedule:
#   Start: 8:00 AM ET, Monday–Friday
#   Stop:  12:00 AM (midnight) ET, Tuesday–Saturday (night after each workday)

for FUNC in start stop; do
    SCHEDULE_NAME="nightshift-${FUNC}"
    LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${SCHEDULE_NAME}"

    if [ "$FUNC" = "start" ]; then
        CRON_EXPR="cron(0 8 ? * MON-FRI *)"
    else
        CRON_EXPR="cron(0 0 ? * TUE-SAT *)"
    fi

    TARGET="{\"RoleArn\":\"${SCHEDULER_ROLE_ARN}\",\"Arn\":\"${LAMBDA_ARN}\"}"

    # Try to get existing schedule; create or update accordingly
    if aws scheduler get-schedule --name "$SCHEDULE_NAME" --region "$REGION" &>/dev/null; then
        echo "==> Updating schedule: $SCHEDULE_NAME ($CRON_EXPR)"
        aws scheduler update-schedule \
            --name "$SCHEDULE_NAME" \
            --schedule-expression "$CRON_EXPR" \
            --schedule-expression-timezone "America/New_York" \
            --target "$TARGET" \
            --flexible-time-window '{"Mode":"OFF"}' \
            --region "$REGION" \
            --output text > /dev/null
    else
        echo "==> Creating schedule: $SCHEDULE_NAME ($CRON_EXPR)"
        aws scheduler create-schedule \
            --name "$SCHEDULE_NAME" \
            --schedule-expression "$CRON_EXPR" \
            --schedule-expression-timezone "America/New_York" \
            --target "$TARGET" \
            --flexible-time-window '{"Mode":"OFF"}' \
            --region "$REGION" \
            --output text > /dev/null
    fi
    echo "    $SCHEDULE_NAME → $CRON_EXPR (America/New_York)"
done

echo ""
echo "=== Cron setup complete ==="
echo ""
echo "  Schedule:"
echo "    Start: 8:00 AM ET, Mon–Fri"
echo "    Stop:  12:00 AM ET, Tue–Sat"
echo ""
echo "  Test manually:"
echo "    aws lambda invoke --function-name nightshift-stop /tmp/out.json && cat /tmp/out.json"
echo "    aws lambda invoke --function-name nightshift-start /tmp/out.json && cat /tmp/out.json"
echo ""
echo "  Elastic IP: $EIP"
echo "  ssh -i ~/.ssh/nightshift-dev.pem ubuntu@$EIP"
