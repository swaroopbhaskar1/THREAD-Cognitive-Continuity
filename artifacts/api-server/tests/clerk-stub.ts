// Used ONLY by the test bundler alias. Never imported by the app or its production build.
export function getAuth(req: { headers: Record<string, string | undefined> }) {
  return { userId: req.headers["x-test-owner"] || null };
}
export function clerkMiddleware() {
  return (_req: unknown, _res: unknown, next: () => void) => next();
}
