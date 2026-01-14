#!/bin/sh
case "$1" in
  "dev-commonjs")
    echo "Starting CommonJS dev server..."
    cd /app/tests/test-commonjs
    npm run reinstall
    npm i --force
    npm run dev -- --host
    ;;
  "dev-nextjs")
    echo "Starting Next.js dev server..."
    cd /app/tests/test-nextjs
    npm run reinstall
    npm i --force
    npm run dev -- --host 0.0.0.0
    ;;
  "dev-nextjs-cjs")
    echo "Starting Next.js CJS dev server..."
    cd /app/tests/test-nextjs-cjs
    npm run reinstall
    npm i --force
    npm run dev -- --host 0.0.0.0
    ;;
  *)
    echo "Usage: docker run <image> [dev-commonjs|dev-nextjs|dev-nextjs-cjs]"
    echo "  dev-commonjs    - Start CommonJS dev server"
    echo "  dev-nextjs      - Start Next.js dev server"
    echo "  dev-nextjs-cjs  - Start Next.js CJS dev server"
    exit 1
    ;;
esac
