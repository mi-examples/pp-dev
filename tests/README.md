# Docker Testing Environment

This testing setup allows running e2e tests for pp-dev in an isolated Docker environment.

## Test Structure

- `test-commonjs` - Tests for CommonJS/Vite modules
- `test-nextjs` - Tests for Next.js applications (ESM)
- `test-nextjs-cjs` - Tests for Next.js applications (CommonJS)

## Usage

### 1. Build the package first

```bash
# From project root directory
npm run build
```

This creates `metricinsights-pp-dev-latest.tgz` which is used by the test projects.

### 2. Running Tests

#### Run All Tests
```bash
npm test
# or
npm test -- --all
```

#### Run Specific Tests
```bash
# Only CommonJS tests
npm test -- -t dev-commonjs

# Only Next.js tests
npm test -- -t dev-nextjs

# Only Next.js CJS tests
npm test -- -t dev-nextjs-cjs
```

### 3. Manual Docker Commands

#### Building Docker Image
```bash
docker build -f Dockerfile -t pp-dev-tests .
```

#### Run Dev Servers in Docker
```bash
# CommonJS dev server
docker run --rm -p 3000:3000 pp-dev-tests dev-commonjs

# Next.js dev server
docker run --rm -p 3000:3000 pp-dev-tests dev-nextjs

# Next.js CJS dev server
docker run --rm -p 3000:3000 pp-dev-tests dev-nextjs-cjs
```

## Available Test Types

### Development Servers
- `dev-commonjs` - Start CommonJS/Vite dev server (port 3000)
- `dev-nextjs` - Start Next.js dev server (port 3000)
- `dev-nextjs-cjs` - Start Next.js CJS dev server (port 3000)

## Docker Image Structure

```
/app/
├── metricinsights-pp-dev-latest.tgz  # Built pp-dev package
└── tests/
    ├── test-commonjs/   # CommonJS/Vite tests
    ├── test-nextjs/     # Next.js ESM tests
    └── test-nextjs-cjs/ # Next.js CJS tests
```

## Configuration

Dockerfile automatically:
1. Uses Node.js 22 Alpine
2. Copies the built pp-dev package
3. Copies test folders
4. Installs dependencies and runs dev servers

## Requirements

- Docker
- Node.js 22+ (for local development)
- Playwright (`npx playwright install` for local browser testing)
