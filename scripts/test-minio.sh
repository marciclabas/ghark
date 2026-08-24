#!/bin/sh
set -eu

project=ghark-minio-test
compose_file=test/integration/compose.minio.yaml
test_root=$(mktemp -d /tmp/ghark-minio-test.XXXXXX)

cleanup() {
  docker compose --project-name "$project" --file "$compose_file" down --volumes
  case "$test_root" in
    /tmp/ghark-minio-test.*) rm -rf "$test_root" ;;
    *) echo "Refusing to remove unexpected test directory: $test_root" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

docker compose --project-name "$project" --file "$compose_file" up --detach --wait minio
docker compose --project-name "$project" --file "$compose_file" run --rm create-bucket

export RESTIC_REPOSITORY=s3:http://127.0.0.1:19000/ghark/test
export RESTIC_PASSWORD=ghark-restic-test
export AWS_ACCESS_KEY_ID=ghark-test
export AWS_SECRET_ACCESS_KEY=ghark-test-password
export AWS_DEFAULT_REGION=us-east-1
mkdir -p "$test_root/source" "$test_root/restore"
printf '%s\n' 'ghark S3 round trip' > "$test_root/source/payload.txt"

docker run --rm --network host \
  --env RESTIC_REPOSITORY --env RESTIC_PASSWORD \
  --env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY --env AWS_DEFAULT_REGION \
  restic/restic:0.19.1 -o s3.bucket-lookup=path init
docker run --rm --network host \
  --volume "$test_root/source:/data:ro" \
  --env RESTIC_REPOSITORY --env RESTIC_PASSWORD \
  --env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY --env AWS_DEFAULT_REGION \
  restic/restic:0.19.1 -o s3.bucket-lookup=path backup /data
docker run --rm --network host \
  --volume "$test_root/restore:/restore" \
  --env RESTIC_REPOSITORY --env RESTIC_PASSWORD \
  --env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY --env AWS_DEFAULT_REGION \
  restic/restic:0.19.1 -o s3.bucket-lookup=path restore latest --target /restore
cmp "$test_root/source/payload.txt" "$test_root/restore/data/payload.txt"
docker run --rm --network host \
  --env RESTIC_REPOSITORY --env RESTIC_PASSWORD \
  --env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY --env AWS_DEFAULT_REGION \
  restic/restic:0.19.1 -o s3.bucket-lookup=path check
