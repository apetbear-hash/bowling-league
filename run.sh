#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d "venv" ]; then
  echo "Creating virtual environment..."
  python3 -m venv venv
  source venv/bin/activate
  pip install flask -q
else
  source venv/bin/activate
fi
echo "Starting Bowling League Manager at http://localhost:5000"
python3 app.py
