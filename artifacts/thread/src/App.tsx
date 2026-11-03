import { useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { Redirect, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppShell } from '@/components/shell';
import NotFound from '@/pages/not-found';
import Home from '@/pages/home';
import MissionsPage from '@/pages/missions';
import MissionPage from '@/pages/mission';
import HowItWorksPage from '@/pages/how-it-works';
import ReviewsPage from '@/pages/reviews';
import ReviewPage from '@/pages/review';
import GettingStartedPublic, { GettingStartedContent } from '@/pages/getting-started';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: 'hsl(8 64% 44%)',
    colorForeground: 'hsl(200 32% 14%)',
    colorMutedForeground: 'hsl(200 12% 38%)',
    colorDanger: 'hsl(350 70% 40%)',
    colorBackground: 'hsl(40 45% 97%)',
    colorInput: 'hsl(38 36% 94%)',
    colorInputForeground: 'hsl(200 32% 14%)',
    colorNeutral: 'hsl(200 20% 30%)',
    fontFamily: "'DM Sans', sans-serif",
    borderRadius: '0.75rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[hsl(40_45%_97%)] rounded-2xl w-[440px] max-w-full overflow-hidden border border-[hsl(34_22%_82%)] shadow-[0_30px_60px_-30px_hsl(200_32%_14%/0.35)]',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: "text-[hsl(200_32%_14%)] font-['Fraunces'] text-2xl",
    headerSubtitle: 'text-[hsl(200_12%_38%)]',
    socialButtonsBlockButtonText: 'text-[hsl(200_32%_14%)] font-medium',
    formFieldLabel: 'text-[hsl(200_32%_14%)]',
    footerActionLink: 'text-[hsl(8_64%_44%)] font-medium',
    footerActionText: 'text-[hsl(200_12%_38%)]',
    dividerText: 'text-[hsl(200_12%_38%)]',
    identityPreviewEditButton: 'text-[hsl(8_64%_44%)]',
    formFieldSuccessText: 'text-[hsl(186_32%_30%)]',
    alertText: 'text-[hsl(200_32%_14%)]',
    logoBox: 'justify-center',
    logoImage: 'h-10 w-10',
    socialButtonsBlockButton: 'border border-[hsl(34_22%_82%)] bg-[hsl(38_36%_94%)]',
    formButtonPrimary: 'bg-[hsl(8_64%_44%)] text-[hsl(40_45%_97%)] rounded-full',
    formFieldInput: 'border border-[hsl(34_20%_76%)] bg-[hsl(38_36%_94%)]',
    footerAction: 'justify-center',
    dividerLine: 'bg-[hsl(34_22%_82%)]',
    alert: 'border border-[hsl(350_70%_40%/0.3)] bg-[hsl(350_70%_40%/0.06)]',
    otpCodeFieldInput: 'border border-[hsl(34_20%_76%)]',
    formFieldRow: 'gap-2',
    main: 'gap-5',
  },
};

function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10 relative overflow-hidden">
      <svg className="absolute inset-x-0 top-1/3 w-full opacity-60 pointer-events-none" viewBox="0 0 1200 200" preserveAspectRatio="none" aria-hidden="true">
        <path className="thread-line" d="M0 150 C 200 20, 400 200, 600 100 S 1000 0, 1200 90" fill="none" stroke="hsl(var(--primary))" strokeWidth="2" />
      </svg>
      <div className="relative">{children}</div>
    </div>
  );
}

function SignInPage() {
  return (
    <AuthFrame>
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </AuthFrame>
  );
}

function SignUpPage() {
  return (
    <AuthFrame>
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </AuthFrame>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function HomeRedirect() {
  const { isLoaded, isSignedIn } = useUser();
  // Public content must remain useful while the authentication SDK loads.
  // This does not relax the separate protected routes or server authorization.
  return isLoaded && isSignedIn ? <Redirect to="/missions" /> : <Home />;
}

function Protected(Page: ComponentType) {
  return function ProtectedPage() {
    return (
      <>
        <Show when="signed-in"><AppShell><Page /></AppShell></Show>
        <Show when="signed-out"><Redirect to="/" /></Show>
      </>
    );
  };
}

const MissionsRoute = Protected(MissionsPage);
const MissionRoute = Protected(MissionPage);
const HowRoute = Protected(HowItWorksPage);
const ReviewsRoute = Protected(ReviewsPage);
const ReviewRoute = Protected(ReviewPage);

function GuideRoute() {
  const { isLoaded, isSignedIn } = useUser();
  return isLoaded && isSignedIn
    ? <AppShell><GettingStartedContent /></AppShell>
    : <GettingStartedPublic />;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: 'Welcome back to Thread', subtitle: 'Pick up where your thinking left off' } },
        signUp: { start: { title: 'Start your thread', subtitle: 'A private place to keep your reasoning between sessions' } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <RoutedErrorBoundary>
            <Switch>
              <Route path="/" component={HomeRedirect} />
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
              <Route path="/missions" component={MissionsRoute} />
              <Route path="/missions/:id" component={MissionRoute} />
              <Route path="/getting-started" component={GuideRoute} />
              <Route path="/how-it-works" component={HowRoute} />
              <Route path="/reviews" component={ReviewsRoute} />
              <Route path="/reviews/:id" component={ReviewRoute} />
              <Route component={NotFound} />
            </Switch>
          </RoutedErrorBoundary>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
