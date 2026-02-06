#!/bin/bash
set -e

# Wait for Redis to be ready
if [ "${REDIS_URL:-}" ]; then
    echo "Waiting for Redis to be availabsle..."
    max_attempts=30
    attempt=0
    while [ $attempt -lt $max_attempts ]; do
        if python -c "
import redis
import sys
try:
    r = redis.from_url('${REDIS_URL}')
    r.ping()
    print('Redis is ready')
    sys.exit(0)
except Exception as e:
    sys.exit(1)
" 2>/dev/null; then
            break
        fi
        attempt=$((attempt+1))
        if [ $attempt -eq $max_attempts ]; then
            echo "⚠️  Redis failed to start after $max_attempts attempts"
            echo "   Continuing with filesystem session management..."
            break
        fi
        echo "   Attempt $attempt/$max_attempts..."
        sleep 2
    done
else
    echo "No Redis URL configured, using filesystem sessions"
fi

# Create upload directory
mkdir -p /tmp/purrrr
chmod 755 /tmp/purrrr

echo ""
echo "Starting Flask application..."
echo "   Access: http://0.0.0.0:5000"
echo "   Max file size: ${MAX_FILE_SIZE:-500}MB"
echo ""

exec python run_web.py --host 0.0.0.0 --port 5000
