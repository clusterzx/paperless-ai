#!/bin/bash
# start-services.sh - Start the Node.js app and (optionally) the Python RAG service.
#
# The RAG service is enabled by default. Set RAG_SERVICE_ENABLED=false to skip the
# Python RAG backend entirely. That avoids loading torch/sentence-transformers/chromadb
# (~1GB RAM) for users who run paperless-ai purely as an LLM tagging frontend and do not
# use the in-app RAG chat. The Node app already gates its /rag routes on this same
# variable (see server.js), so honoring it here is all that is required.

# Respect a caller-provided value; only default when unset. Do NOT hardcode.
export RAG_SERVICE_URL="${RAG_SERVICE_URL:-http://localhost:8000}"
export RAG_SERVICE_ENABLED="${RAG_SERVICE_ENABLED:-true}"

PYTHON_PID=""
if [ "$RAG_SERVICE_ENABLED" = "true" ]; then
    # Activate virtual environment for Python
    source /app/venv/bin/activate

    echo "Starting Python RAG service..."
    python main.py --host 127.0.0.1 --port 8000 --initialize &
    PYTHON_PID=$!

    # Give it a moment to initialize
    sleep 2
    echo "Python RAG service started with PID: $PYTHON_PID"
else
    echo "RAG_SERVICE_ENABLED=$RAG_SERVICE_ENABLED - skipping Python RAG service."
fi

# Start the Node.js application (inherits the exports above)
echo "Starting Node.js Paperless-AI service..."
pm2-runtime ecosystem.config.js

# If Node.js exits, stop the Python service (only if it was started)
[ -n "$PYTHON_PID" ] && kill "$PYTHON_PID"
