# Use official Node.js image
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy the built pp-dev package
COPY metricinsights-pp-dev-latest.tgz ./

# Copy test folders (without node_modules - they will be installed)
COPY tests/ ./tests/

# Copy and setup script for running tests
COPY run-tests.sh /usr/local/bin/run-tests.sh

# Fix line endings (Windows -> Unix)
RUN sed -i 's/\r$//' /usr/local/bin/run-tests.sh

# Make script executable
RUN chmod +x /usr/local/bin/run-tests.sh

# Set entry point
ENTRYPOINT ["/usr/local/bin/run-tests.sh"]

# Default command runs commonjs tests
CMD ["dev-commonjs"]
