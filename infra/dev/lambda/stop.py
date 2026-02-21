import boto3

ec2 = boto3.client("ec2")

def handler(event, context):
    # Find running instances tagged nightshift-dev
    response = ec2.describe_instances(
        Filters=[
            {"Name": "tag:Name", "Values": ["nightshift-dev"]},
            {"Name": "instance-state-name", "Values": ["running"]},
        ]
    )

    instance_ids = [
        i["InstanceId"]
        for r in response["Reservations"]
        for i in r["Instances"]
    ]

    if not instance_ids:
        print("No running nightshift-dev instances found")
        return {"stopped": []}

    print(f"Stopping instances: {instance_ids}")
    ec2.stop_instances(InstanceIds=instance_ids)

    # Wait for stopped state
    waiter = ec2.get_waiter("instance_stopped")
    waiter.wait(InstanceIds=instance_ids)
    print(f"Instances stopped: {instance_ids}")

    return {"stopped": instance_ids}
