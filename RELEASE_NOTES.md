# Release v1.1.1 - MySQL Pooling Improvements

This release includes a focused set of improvements to the MySQL adapter for better reliability when connecting to remote hosting providers (cPanel, shared hosting, and similar). Changes include:

- Use of `mysql2` connection pool (`createPool`) instead of a single connection.
- Automatic keep-alive and more aggressive keep-alive timing to reduce remote timeout drops.
- `ensureConnection()` logic that tests the pool and reinitializes it on failure.
- Automatic retry once on connection-related query failures (e.g., `PROTOCOL_CONNECTION_LOST`).
- Adjusted pool defaults tuned for shared hosting (reduced connectionLimit and idle timeout).

How to use:
- Build the project (`npm install && npm run build`) and configure your MCP to run the local built `dist/src/index.js` with `node` in `mcp.json`.

Notes:
- This is a patch release; version bumped to `1.1.1`.
- If you maintain a fork or publish a package, consider publishing under a scoped name.
