import { Link } from "wouter";
import { ArrowRight, BookmarkCheck, Compass, HelpCircle, PenLine } from "lucide-react";
import { ThreadMark } from "@/components/shell";

const steps = [
  { icon: PenLine, title: "Capture a thought", body: "What makes sense, what is still unclear. Saved as you type, kept locally if the network drops." },
  { icon: BookmarkCheck, title: "Save a stopping point", body: "Before you stop, write one concrete next step and save a checkpoint. That alone is enough." },
  { icon: HelpCircle, title: "Come back to a clear step", body: "Your next step is the first thing you see. Continue right away, or try a question from memory first." },
  { icon: Compass, title: "Notice what changed", body: "Your journey puts earlier checkpoints beside your current thinking, in your own words." },
];

export default function Home() {
  return (
    <div className="min-h-[100dvh] overflow-hidden">
      <header className="mx-auto max-w-6xl px-5 sm:px-8 h-16 flex items-center">
        <span className="flex items-center gap-2 font-display text-xl"><ThreadMark /> Thread</span>
        <nav className="ml-auto flex items-center gap-2">
          <Link href="/getting-started" className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground" data-testid="link-guide">Guide</Link>
          <Link href="/sign-in" className="hidden sm:inline px-3 py-2 text-sm text-muted-foreground hover:text-foreground" data-testid="link-how">Execution</Link>
          <Link href="/sign-in" className="px-3 py-2 text-sm hover:text-primary" data-testid="link-sign-in">Sign in</Link>
          <Link href="/sign-up" className="px-4 py-2 text-sm rounded-full bg-foreground text-background hover:bg-primary transition-colors" data-testid="link-sign-up">Start a thread</Link>
        </nav>
      </header>

      <section className="relative mx-auto max-w-6xl px-5 sm:px-8 pt-14 sm:pt-24 pb-24">
        <svg className="absolute right-0 top-10 w-[70%] max-w-[720px] opacity-90 pointer-events-none" viewBox="0 0 700 300" aria-hidden="true">
          <path className="thread-line" d="M0 220 C 120 80, 200 300, 320 160 S 520 40, 600 150 S 680 220, 700 120" fill="none" stroke="hsl(var(--primary))" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="700" cy="120" r="6" fill="hsl(var(--primary))" />
        </svg>
        <p className="rise font-mono text-xs uppercase tracking-[0.25em] text-accent">Cognitive continuity for learners</p>
        <h1 className="rise font-display text-5xl sm:text-7xl lg:text-8xl leading-[0.95] mt-6 max-w-4xl" style={{ animationDelay: "120ms" }}>
          Pick up the <em className="text-primary not-italic font-display italic">thread</em> of your thinking.
        </h1>
        <p className="rise mt-8 max-w-xl text-lg text-muted-foreground leading-relaxed" style={{ animationDelay: "240ms" }}>
          THREAD saves where your thinking stopped, so your next study session starts with a clear next step. Write one, save, and come back to it.
        </p>
        <div className="rise mt-10 flex flex-wrap gap-3" style={{ animationDelay: "360ms" }}>
          <Link href="/sign-up" className="group inline-flex items-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground hover:-translate-y-0.5 transition-transform" data-testid="button-hero-start">
            Begin your first mission <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
          </Link>
          <Link href="/getting-started" className="inline-flex items-center px-6 py-3 rounded-full border border-border hover:bg-card transition-colors" data-testid="button-hero-guide">See the learning flow</Link>
          <Link href="/sign-in" className="inline-flex items-center px-4 py-3 text-sm text-muted-foreground hover:text-foreground" data-testid="button-hero-how">Sign in</Link>
        </div>
      </section>

      <section className="bg-foreground text-background">
        <div className="mx-auto max-w-6xl px-5 sm:px-8 py-20 grid md:grid-cols-[1fr_1.4fr] gap-12">
          <div>
            <h2 className="font-display text-4xl sm:text-5xl leading-tight">Rereading is not remembering.</h2>
            <p className="mt-5 text-background/70 leading-relaxed">Most tools save your files. Thread saves your state of mind: the question you were circling, the step you'd committed to, the doubt you hadn't resolved.</p>
          </div>
          <ol className="grid sm:grid-cols-2 gap-px bg-background/15 rounded-2xl overflow-hidden">
            {steps.map((s, i) => (
              <li key={s.title} className="bg-foreground p-6">
                <div className="flex items-center gap-3 text-primary"><s.icon className="h-5 w-5" /><span className="font-mono text-xs text-background/50">0{i + 1}</span></div>
                <h3 className="font-display text-xl mt-4">{s.title}</h3>
                <p className="mt-2 text-sm text-background/70 leading-relaxed">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 sm:px-8 py-20 grid md:grid-cols-2 gap-10 items-center">
        <div className="rounded-2xl border border-border bg-card p-6 shadow-[0_30px_60px_-30px_hsl(200_32%_14%/0.25)] -rotate-1">
          <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Optional recall · illustrative example</p>
          <p className="font-display text-2xl mt-3 leading-snug">Before you look, what were you about to try next?</p>
          <div className="mt-5 h-20 rounded-lg border border-dashed border-input" />
          <div className="mt-4 flex gap-2 text-xs">
            <span className="px-3 py-1 rounded-full bg-primary text-primary-foreground">Reveal checkpoint</span>
            <span className="px-3 py-1 rounded-full border border-border">Skip</span>
          </div>
        </div>
        <div>
          <h2 className="font-display text-4xl leading-tight">Honest about how it works.</h2>
          <p className="mt-4 text-muted-foreground leading-relaxed">Every save, checkpoint, and resumption is recorded as a real workflow with measured timings. When AI is not used, Thread says why. Nothing in the Execution view is staged.</p>
          <Link href="/sign-in" className="inline-flex items-center gap-2 mt-6 text-primary hover:underline underline-offset-4" data-testid="link-observability">Sign in to open Execution <ArrowRight className="h-4 w-4" /></Link>
        </div>
      </section>

      <footer className="border-t border-border py-8 text-center text-sm text-muted-foreground">Thread. A quiet place to keep going.</footer>
    </div>
  );
}
