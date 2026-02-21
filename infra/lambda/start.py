import boto3

ec2 = boto3.client("ec2")

def handler(event, context):
    # Find stopped instances tagged nightshift-dev
    response = ec2.describe_instances(
        Filters=[
            {"Name": "tag:Name", "Values": ["nightshift-dev"]},
            {"Name": "instance-state-name", "Values": ["stopped"]},
        ]
    )

    instance_ids = [
        i["InstanceId"]
        for r in response["Reservations"]
        for i in r["Instances"]
    ]

    if not instance_ids:
        print("No stopped nightshift-dev instances found")
        return {"started": []}

    print(f"Starting instances: {instance_ids}")
    ec2.start_instances(InstanceIds=instance_ids)

    # Wait for running state
    waiter = ec2.get_waiter("instance_running")
    waiter.wait(InstanceIds=instance_ids)
    print(f"Instances running: {instance_ids}")

    return {"started": instance_ids}
