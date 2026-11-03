// Compiled only by the test runner with its test-only Clerk adapter.
import app from "../src/app";
import { pool } from "@workspace/db";

const connect = pool.connect.bind(pool);
(pool as any).connect = async (...args: any[]) => {
  if (args.length) return (connect as any)(...args); // Preserve pg.Pool's callback-based query path.
  const client: any = await (connect as any)(...args);
  const query = client.query.bind(client);
  client.query = async (...q: any[]) => {
    const value = await query(...q);
    const text = typeof q[0] === "string" ? q[0] : q[0]?.text ?? "";
    const target = process.env.CHECKPOINT_STOP_PHASE === "before_commit" ? /INSERT INTO checkpoints/i.test(text) : text === "COMMIT";
    if (target) {
      process.send?.({ phase: process.env.CHECKPOINT_STOP_PHASE });
      await new Promise(() => {}); // Parent SIGKILLs a real pending request.
    }
    return value;
  };
  return client;
};
const server = app.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") process.send?.({ port: address.port });
});
