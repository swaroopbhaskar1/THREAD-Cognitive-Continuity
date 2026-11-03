import type { ReactNode } from "react";
import { Link } from "wouter";
import { Show } from "@clerk/react";
import { ArrowRight, BookmarkCheck, PenLine, RotateCcw } from "lucide-react";
import { ThreadMark } from "@/components/shell";

const STORY = [
  { icon: PenLine, when: "While you're learning", body: "Write down something you understand, something confusing, or an idea you want to remember." },
  { icon: BookmarkCheck, when: "Before you stop", body: "Leave yourself one concrete next step. Save a checkpoint so your earlier thinking stays available." },
  { icon: RotateCcw, when: "When you come back", body: "Pick up from your next step, optionally test your memory, and see what changed since your earlier checkpoint." },
];

function Stage({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <li className="relative rounded-2xl border border-border bg-card p-5 min-w-0">
      <p className="font-mono text-[11px] uppercase tracking-widest text-accent">{n} · {title}</p>
      <div className="mt-3 space-y-3 text-sm">{children}</div>
    </li>
  );
}
function Line({ label, children }: { label: string; children: ReactNode }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-0.5 [overflow-wrap:anywhere]">{children}</p></div>;
}

/** Public product guide. Everything below is illustrative; nothing is a real record or execution. */
export function GettingStartedContent() {
  return (
    <div className="mx-auto max-w-6xl px-5 sm:px-8 pb-20">
      <section className="relative pt-12 sm:pt-20 pb-14">
        <svg className="absolute right-0 top-8 w-[55%] max-w-[560px] opacity-80 pointer-events-none hidden md:block" viewBox="0 0 600 200" aria-hidden="true">
          <path className="thread-line" d="M0 150 C 110 40, 190 190, 300 100 S 470 30, 600 110" fill="none" stroke="hsl(var(--primary))" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <p className="rise font-mono text-xs uppercase tracking-[0.25em] text-accent">Guide</p>
        <h1 className="rise font-display text-4xl sm:text-6xl leading-[1.02] mt-4 max-w-3xl" style={{ animationDelay: "100ms" }} data-testid="text-guide-headline">
          A useful place to stop. An easier place to restart.
        </h1>
        <p className="rise mt-6 max-w-xl text-lg text-muted-foreground leading-relaxed" style={{ animationDelay: "200ms" }}>
          THREAD saves where your thinking stopped, so your next study session starts with a clear next step. A <strong className="text-foreground font-medium">mission</strong> is one topic or learning goal.
        </p>
      </section>

      <ol className="grid md:grid-cols-3 gap-px rounded-2xl overflow-hidden bg-border" data-testid="list-guide-story">
        {STORY.map((s, i) => (
          <li key={s.when} className="rise bg-card p-6 sm:p-7" style={{ animationDelay: `${280 + i * 90}ms` }}>
            <div className="flex items-center gap-3 text-primary"><s.icon className="h-5 w-5" /><span className="font-mono text-xs text-muted-foreground">0{i + 1}</span></div>
            <h2 className="font-display text-2xl mt-4">{s.when}</h2>
            <p className="mt-2 text-muted-foreground leading-relaxed">{s.body}</p>
          </li>
        ))}
      </ol>

      <section className="mt-20" aria-labelledby="example-heading" data-testid="section-guide-example">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-dashed border-primary/60 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-primary" data-testid="badge-illustrative">Illustrative example · not a real record</p>
            <h2 id="example-heading" className="font-display text-3xl sm:text-4xl mt-4">One evening with sliding windows</h2>
          </div>
          <p className="max-w-sm text-sm text-muted-foreground">A made-up student, written to show the flow. Your own missions start empty and contain only what you write.</p>
        </div>
        <ol className="mt-8 grid md:grid-cols-2 xl:grid-cols-4 gap-4">
          <Stage n="1" title="You write">
            <Line label="What I was studying">Sliding windows</Line>
            <Line label="What confused me">Why the left pointer shouldn't move backward on <code className="font-mono text-primary">abba</code></Line>
            <Line label="Where I will pick up">Trace each window and record where the pointers move.</Line>
          </Stage>
          <Stage n="2" title="THREAD saves">
            <div className="rounded-xl bg-foreground text-background p-4">
              <p className="font-mono text-[10px] uppercase tracking-widest text-background/70">Checkpoint saved</p>
              <p className="mt-1 font-display text-lg leading-snug">Ready for your next session</p>
              <p className="mt-2 text-background/80 text-xs">Your uncertainty, explanation and next step, kept exactly as written.</p>
            </div>
            <Line label="What AI could add">A question about the pointer rule, written only from these notes, when there is enough to work with.</Line>
          </Stage>
          <Stage n="3" title="You return">
            <p className="font-display text-lg leading-snug">Your next step: trace <span className="font-mono text-primary text-base">abba</span> and record each window.</p>
            <p className="text-muted-foreground">No reconstructing the last session. Continue, or first try a question from memory.</p>
            <span className="inline-flex rounded-full bg-primary text-primary-foreground px-3 py-1 text-xs" aria-hidden="true">Continue learning</span>
          </Stage>
          <Stage n="4" title="You notice what changed">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg bg-muted p-2"><p className="font-mono text-[10px] uppercase text-muted-foreground">Then</p><p className="mt-1">I don't get why the left pointer can't move backward.</p></div>
              <div className="rounded-lg border border-accent/50 p-2"><p className="font-mono text-[10px] uppercase text-accent">Now</p><p className="mt-1">It stays at the furthest valid position so excluded characters stay out.</p></div>
            </div>
            <p className="text-muted-foreground">Your own words side by side. No scores.</p>
          </Stage>
        </ol>
      </section>

      <section className="mt-20 grid md:grid-cols-[1.2fr_1fr] gap-8 items-start">
        <div className="rounded-2xl bg-foreground text-background p-7 sm:p-9">
          <h2 className="font-display text-3xl">Start with one next step.</h2>
          <p className="mt-3 text-background/75">Create a mission, write where you will pick up, and save. Everything else is optional.</p>
          <Show when="signed-in">
            <Link href="/missions" className="group mt-6 inline-flex items-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground hover:-translate-y-0.5 transition-transform" data-testid="link-guide-missions">Go to your missions <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" /></Link>
          </Show>
          <Show when="signed-out">
            <Link href="/sign-up" className="group mt-6 inline-flex items-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground hover:-translate-y-0.5 transition-transform" data-testid="link-guide-sign-up">Start your first mission <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" /></Link>
          </Show>
        </div>
        <div className="rounded-2xl border border-border p-7">
          <p className="font-mono text-[11px] uppercase tracking-widest text-accent">Curious how it is built?</p>
          <h2 className="font-display text-2xl mt-2">How THREAD runs</h2>
          <p className="mt-2 text-sm text-muted-foreground">The Execution view shows real recorded operations: each step, its measured timing, and replay. It needs a sign-in because it shows your own activity.</p>
          <Show when="signed-in"><Link href="/how-it-works" className="mt-4 inline-flex items-center gap-1.5 text-primary hover:underline underline-offset-4" data-testid="link-guide-execution">Open Execution <ArrowRight className="h-4 w-4" /></Link></Show>
          <Show when="signed-out"><Link href="/sign-in" className="mt-4 inline-flex items-center gap-1.5 text-primary hover:underline underline-offset-4" data-testid="link-guide-execution">Sign in to open Execution <ArrowRight className="h-4 w-4" /></Link></Show>
        </div>
      </section>
    </div>
  );
}

export default function GettingStartedPublic() {
  return (
    <div className="min-h-[100dvh]">
      <header className="mx-auto max-w-6xl px-5 sm:px-8 h-16 flex items-center">
        <Link href="/" className="flex items-center gap-2 font-display text-xl" data-testid="link-guide-home"><ThreadMark /> Thread</Link>
        <nav className="ml-auto flex items-center gap-1 sm:gap-2" aria-label="Public navigation">
          <Link href="/sign-in" className="hidden sm:inline px-3 py-2 text-sm text-muted-foreground hover:text-foreground" data-testid="link-guide-nav-execution">Execution</Link>
          <Link href="/sign-in" className="px-3 py-2 text-sm hover:text-primary" data-testid="link-guide-sign-in">Sign in</Link>
        </nav>
      </header>
      <GettingStartedContent />
    </div>
  );
}
