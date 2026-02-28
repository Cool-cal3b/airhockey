#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

cleanup() {
  echo ""
  echo "Shutting down dev server..."
  kill $DEV_PID 2>/dev/null
  wait $DEV_PID 2>/dev/null
  exit 0
}

trap cleanup SIGINT SIGTERM

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting dev server..."
npm run dev &
DEV_PID=$!

sleep 2

if command -v open &>/dev/null; then
  open -a "Google Chrome" "http://localhost:5173"
elif command -v xdg-open &>/dev/null; then
  xdg-open "http://localhost:5173"
fi

wait $DEV_PID
