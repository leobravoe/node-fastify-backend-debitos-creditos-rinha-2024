#!/bin/bash
# wait-for-it.sh script to wait for PostgreSQL to be ready

set -e

host="$1"
shift
cmd="$@"

echo "Waiting for PostgreSQL to be ready..."

until pg_isready -h "$host" -U "$DB_USER" -d "$DB_DATABASE"; do
  echo "PostgreSQL is unavailable - sleeping"
  sleep 2
done

echo "PostgreSQL is up - executing command"
exec $cmd 