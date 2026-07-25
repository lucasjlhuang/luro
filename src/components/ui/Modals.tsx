import {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  CharacterStatus,
  PEER_IDS,
  Role,
  Task,
  partnerOf,
  useAppStore,
} from '../../store/useAppStore';
import { renderStrokes } from '../../lib/strokes';

/* ------------------------------------------------------------------ */
/* Shared glass panel                                                 */
/* ------------------------------------------------------------------ */

function Panel({
  title,
  width = 'w-[440px]',
  children,
}: {
  title: string;
  width?: string;
  children: ReactNode;
}) {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  return (
    <div
      data-interactive
      className={`pointer-events-auto flex flex-col rounded-2xl border border-white/15 bg-slate-900/80 text-slate-100 shadow-2xl backdrop-blur-xl ${width}`}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <h2 className="text-sm font-semibold tracking-wide">{title}</h2>
        <button
          onClick={() => setActiveModal('NONE')}
          aria-label="Close"
          className="rounded-md px-2 py-0.5 text-slate-400 transition hover:bg-white/10 hover:text-white"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-hidden p-3">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tiny markdown renderer (headers, lists, bold/italic/code)          */
/* ------------------------------------------------------------------ */

function inlineMd(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (/^\*[^*]+\*$/.test(part)) return <em key={key}>{part.slice(1, -1)}</em>;
    if (/^`[^`]+`$/.test(part))
      return (
        <code key={key} className="rounded bg-white/10 px-1 text-[11px]">
          {part.slice(1, -1)}
        </code>
      );
    return <span key={key}>{part}</span>;
  });
}

function MarkdownView({ source }: { source: string }) {
  if (!source.trim()) {
    return <p className="text-[12px] italic text-slate-500">Nothing written yet…</p>;
  }
  return (
    <div className="space-y-1 text-[12px] leading-relaxed">
      {source.split('\n').map((line, i) => {
        const key = `line-${i}`;
        if (line.startsWith('### '))
          return (
            <h3 key={key} className="text-[13px] font-semibold">
              {inlineMd(line.slice(4), key)}
            </h3>
          );
        if (line.startsWith('## '))
          return (
            <h2 key={key} className="text-sm font-semibold">
              {inlineMd(line.slice(3), key)}
            </h2>
          );
        if (line.startsWith('# '))
          return (
            <h1 key={key} className="text-base font-bold">
              {inlineMd(line.slice(2), key)}
            </h1>
          );
        if (/^[-*] /.test(line))
          return (
            <div key={key} className="flex gap-1.5">
              <span className="text-slate-400">•</span>
              <span>{inlineMd(line.slice(2), key)}</span>
            </div>
          );
        if (!line.trim()) return <div key={key} className="h-2" />;
        return <p key={key}>{inlineMd(line, key)}</p>;
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Two-page shared notebook                                           */
/* ------------------------------------------------------------------ */

function NotebookModal() {
  const myNotes = useAppStore((s) => s.myNotes);
  const setMyNotes = useAppStore((s) => s.setMyNotes);
  const partnerNotes = useAppStore((s) => s.partnerNotes);
  const connected = useAppStore((s) => s.connectionStatus === 'CONNECTED');

  return (
    <Panel title="Shared Notebook" width="w-[464px]">
      <div className="flex h-[300px] overflow-hidden rounded-xl bg-amber-950/30 ring-1 ring-white/10">
        <div className="flex flex-1 flex-col bg-amber-50/[0.06] p-2.5">
          <div className="mb-1.5 text-[10px] uppercase tracking-widest text-amber-200/70">
            My page · markdown
          </div>
          <textarea
            value={myNotes}
            onChange={(e) => setMyNotes(e.target.value)}
            spellCheck={false}
            placeholder={'# Today\n- write something…'}
            className="flex-1 resize-none bg-transparent font-mono text-[12px] leading-relaxed text-amber-50 outline-none placeholder:text-amber-100/25"
          />
        </div>
        <div className="w-px bg-white/15" />
        <div className="flex flex-1 flex-col overflow-hidden bg-amber-50/[0.03] p-2.5">
          <div className="mb-1.5 text-[10px] uppercase tracking-widest text-sky-200/70">
            Partner's page {connected ? '· live' : '· offline'}
          </div>
          <div className="flex-1 overflow-y-auto pr-1">
            <MarkdownView source={partnerNotes} />
          </div>
        </div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* 3-column shared corkboard                                          */
/* ------------------------------------------------------------------ */

function IconButton({ label, onClick, title }: { label: string; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded px-1 text-[11px] text-slate-400 transition hover:bg-white/10 hover:text-white"
    >
      {label}
    </button>
  );
}

function TaskCard({ task, actions }: { task: Task; actions?: ReactNode }) {
  return (
    <div className="group rounded-lg bg-white/[0.07] px-2 py-1.5 text-[12px] ring-1 ring-white/10">
      <div className="flex items-start justify-between gap-1">
        <span className="break-words leading-snug">{task.text}</span>
        {actions && (
          <span className="flex shrink-0 gap-0.5 opacity-0 transition group-hover:opacity-100">
            {actions}
          </span>
        )}
      </div>
    </div>
  );
}

function CorkboardModal() {
  const myTasks = useAppStore((s) => s.myTasks);
  const partnerTasks = useAppStore((s) => s.partnerTasks);
  const addTask = useAppStore((s) => s.addTask);
  const updateTaskStatus = useAppStore((s) => s.updateTaskStatus);
  const deleteTask = useAppStore((s) => s.deleteTask);
  const [draft, setDraft] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    addTask(draft);
    setDraft('');
  };

  const todo = myTasks.filter((t) => t.status === 'TODO');
  const doing = myTasks.filter((t) => t.status === 'IN_PROGRESS');
  const columnCls = 'flex min-h-0 flex-col rounded-xl bg-white/[0.04] p-2 ring-1 ring-white/10';
  const headerCls = 'mb-1.5 text-[10px] font-semibold uppercase tracking-widest';
  const listCls = 'flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5';

  return (
    <Panel title="Shared Corkboard" width="w-[464px]">
      <div className="grid h-[300px] grid-cols-3 gap-2">
        <section className={columnCls}>
          <div className={`${headerCls} text-amber-300/80`}>To Do · {todo.length}</div>
          <form onSubmit={submit} className="mb-1.5">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add task…"
              className="w-full rounded-md bg-white/10 px-2 py-1 text-[12px] outline-none ring-1 ring-white/10 placeholder:text-slate-500 focus:ring-amber-300/50"
            />
          </form>
          <div className={listCls}>
            {todo.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                actions={
                  <>
                    <IconButton label="→" title="Start" onClick={() => updateTaskStatus(t.id, 'IN_PROGRESS')} />
                    <IconButton label="✕" title="Delete" onClick={() => deleteTask(t.id)} />
                  </>
                }
              />
            ))}
          </div>
        </section>

        <section className={columnCls}>
          <div className={`${headerCls} text-sky-300/80`}>In Progress · {doing.length}</div>
          <div className={listCls}>
            {doing.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                actions={
                  <>
                    <IconButton label="←" title="Back to To Do" onClick={() => updateTaskStatus(t.id, 'TODO')} />
                    <IconButton label="✓" title="Done (remove)" onClick={() => deleteTask(t.id)} />
                  </>
                }
              />
            ))}
          </div>
        </section>

        <section className={columnCls}>
          <div className={`${headerCls} text-violet-300/80`}>Partner's Tasks · {partnerTasks.length}</div>
          <div className={listCls}>
            {partnerTasks.map((t) => (
              <div key={t.id} className="rounded-lg bg-white/[0.05] px-2 py-1.5 text-[12px] ring-1 ring-white/10">
                <div className="leading-snug">{t.text}</div>
                <div className={`mt-0.5 text-[9px] uppercase tracking-wider ${t.status === 'IN_PROGRESS' ? 'text-sky-400' : 'text-amber-400/80'}`}>
                  {t.status === 'IN_PROGRESS' ? 'in progress' : 'to do'}
                </div>
              </div>
            ))}
            {partnerTasks.length === 0 && (
              <p className="text-[11px] italic text-slate-500">No partner tasks yet.</p>
            )}
          </div>
        </section>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Shared whiteboard                                                  */
/* ------------------------------------------------------------------ */

const PEN_COLORS = ['#1e293b', '#dc2626', '#2563eb', '#16a34a', '#d97706', '#9333ea'];
const PEN_SIZES = [2, 4, 8];
const BOARD_W = 440;
const BOARD_H = 270;
const BOARD_SCALE = 2; // retina backing store

function WhiteboardModal() {
  const strokes = useAppStore((s) => s.strokes);
  const addLocalStroke = useAppStore((s) => s.addLocalStroke);
  const clearWhiteboard = useAppStore((s) => s.clearWhiteboard);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const color = useAppStore((s) => s.penColor);
  const setColor = useAppStore((s) => s.setPenColor);
  const [size, setSize] = useState(4);
  const [eraser, setEraser] = useState(false);
  const live = useRef<{ points: number[] } | null>(null);

  const repaint = useCallback(() => {
    const c = canvasRef.current;
    if (c) renderStrokes(c, strokes, '#ffffff');
  }, [strokes]);

  useEffect(() => {
    repaint();
  }, [repaint]);

  const toLocal = (e: ReactPointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = toLocal(e);
    live.current = { points: [x, y] };
  };

  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!live.current) return;
    const pts = live.current.points;
    const [x, y] = toLocal(e);
    const px = pts[pts.length - 2];
    const py = pts[pts.length - 1];
    if (Math.hypot(x - px, y - py) < 0.004) return;
    pts.push(x, y);

    // Live preview segment; eraser previews as white, the committed
    // stroke is re-rendered with true destination-out compositing.
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) {
      ctx.strokeStyle = eraser ? '#ffffff' : color;
      ctx.lineWidth = (eraser ? size * 3 : size) * BOARD_SCALE;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px * BOARD_W * BOARD_SCALE, py * BOARD_H * BOARD_SCALE);
      ctx.lineTo(x * BOARD_W * BOARD_SCALE, y * BOARD_H * BOARD_SCALE);
      ctx.stroke();
    }
  };

  const onUp = () => {
    if (!live.current) return;
    const { points } = live.current;
    live.current = null;
    if (points.length < 2) return;
    // A click without movement still leaves a dot.
    const finalPoints =
      points.length === 2 ? [...points, points[0] + 0.0005, points[1] + 0.0005] : points;
    addLocalStroke({
      color,
      size: eraser ? size * 3 : size,
      erase: eraser,
      points: finalPoints,
    });
  };

  return (
    <Panel title="Shared Whiteboard" width="w-[464px]">
      <div className="mb-2 flex items-center gap-2">
        <div className="flex items-center gap-1">
          {PEN_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => {
                setColor(c);
                setEraser(false);
              }}
              aria-label={`Pen color ${c}`}
              className={`h-5 w-5 rounded-full ring-2 transition ${
                !eraser && color === c ? 'ring-white' : 'ring-transparent hover:ring-white/40'
              }`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <div className="mx-1 h-5 w-px bg-white/15" />
        <div className="flex items-center gap-1">
          {PEN_SIZES.map((s) => (
            <button
              key={s}
              onClick={() => setSize(s)}
              aria-label={`Pen size ${s}`}
              className={`flex h-6 w-6 items-center justify-center rounded-md transition ${
                size === s ? 'bg-white/20' : 'hover:bg-white/10'
              }`}
            >
              <span className="rounded-full bg-slate-200" style={{ width: s + 2, height: s + 2 }} />
            </button>
          ))}
        </div>
        <div className="mx-1 h-5 w-px bg-white/15" />
        <button
          onClick={() => setEraser((v) => !v)}
          className={`rounded-md px-2 py-0.5 text-[11px] transition ${
            eraser ? 'bg-white/20 text-white' : 'text-slate-300 hover:bg-white/10'
          }`}
        >
          Eraser
        </button>
        <button
          onClick={clearWhiteboard}
          className="ml-auto rounded-md px-2 py-0.5 text-[11px] text-rose-300 transition hover:bg-rose-500/20"
        >
          Clear
        </button>
      </div>
      <canvas
        ref={canvasRef}
        data-draw
        width={BOARD_W * BOARD_SCALE}
        height={BOARD_H * BOARD_SCALE}
        style={{ width: BOARD_W, height: BOARD_H }}
        className="touch-none rounded-xl bg-white"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Synchronized pomodoro timer                                        */
/* ------------------------------------------------------------------ */

function TimerModal() {
  const timer = useAppStore((s) => s.timer);
  const startTimer = useAppStore((s) => s.startTimer);
  const pauseTimer = useAppStore((s) => s.pauseTimer);
  const resetTimer = useAppStore((s) => s.resetTimer);
  const setTimerMode = useAppStore((s) => s.setTimerMode);
  const setTimerDurations = useAppStore((s) => s.setTimerDurations);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, []);

  const remaining =
    timer.isRunning && timer.endsAt !== null ? Math.max(0, timer.endsAt - now) : timer.remainingMs;
  const totalMs = (timer.mode === 'WORK' ? timer.workMin : timer.breakMin) * 60_000;
  const mm = String(Math.floor(remaining / 60_000)).padStart(2, '0');
  const ss = String(Math.floor((remaining % 60_000) / 1000)).padStart(2, '0');
  const done = timer.isRunning && remaining <= 0;
  const nextMode = timer.mode === 'WORK' ? 'BREAK' : 'WORK';

  const tabCls = (active: boolean) =>
    `flex-1 rounded-lg px-3 py-1 text-[12px] font-medium transition ${
      active ? 'bg-white/20 text-white' : 'text-slate-400 hover:bg-white/10'
    }`;

  return (
    <Panel title="Pomodoro Timer" width="w-[320px]">
      <div className="flex flex-col items-center gap-3 py-1">
        <div className="flex w-full gap-1 rounded-xl bg-white/[0.06] p-1">
          <button className={tabCls(timer.mode === 'WORK')} onClick={() => setTimerMode('WORK')}>
            Focus
          </button>
          <button className={tabCls(timer.mode === 'BREAK')} onClick={() => setTimerMode('BREAK')}>
            Break
          </button>
        </div>

        <div className={`font-mono text-5xl font-bold tabular-nums ${done ? 'animate-pulse text-rose-400' : ''}`}>
          {mm}:{ss}
        </div>

        <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className={`h-full rounded-full transition-all ${timer.mode === 'WORK' ? 'bg-rose-400' : 'bg-emerald-400'}`}
            style={{ width: `${totalMs > 0 ? (remaining / totalMs) * 100 : 0}%` }}
          />
        </div>

        {done ? (
          <button
            onClick={() => {
              setTimerMode(nextMode);
              startTimer();
            }}
            className="w-full rounded-xl bg-emerald-500/80 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500"
          >
            Time's up — start {nextMode === 'WORK' ? 'focus' : 'break'}
          </button>
        ) : (
          <div className="flex w-full gap-2">
            <button
              onClick={timer.isRunning ? pauseTimer : startTimer}
              className="flex-1 rounded-xl bg-sky-500/80 py-2 text-sm font-semibold text-white transition hover:bg-sky-500"
            >
              {timer.isRunning ? 'Pause' : 'Start'}
            </button>
            <button
              onClick={resetTimer}
              className="rounded-xl bg-white/10 px-4 py-2 text-sm text-slate-300 transition hover:bg-white/20"
            >
              Reset
            </button>
          </div>
        )}

        <div className="flex w-full items-center justify-between text-[11px] text-slate-400">
          <span>
            Focus{' '}
            <button className="px-1 hover:text-white" onClick={() => setTimerDurations(timer.workMin - 5, timer.breakMin)}>−</button>
            <span className="tabular-nums text-slate-200">{timer.workMin}m</span>
            <button className="px-1 hover:text-white" onClick={() => setTimerDurations(timer.workMin + 5, timer.breakMin)}>+</button>
          </span>
          <span>
            Break{' '}
            <button className="px-1 hover:text-white" onClick={() => setTimerDurations(timer.workMin, timer.breakMin - 1)}>−</button>
            <span className="tabular-nums text-slate-200">{timer.breakMin}m</span>
            <button className="px-1 hover:text-white" onClick={() => setTimerDurations(timer.workMin, timer.breakMin + 1)}>+</button>
          </span>
        </div>
        <p className="text-[10px] text-slate-500">Synced with your partner in real time.</p>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Settings: role/identity switch + connection details                */
/* ------------------------------------------------------------------ */

function SettingsModal() {
  const role = useAppStore((s) => s.role);
  const setRole = useAppStore((s) => s.setRole);
  const status = useAppStore((s) => s.connectionStatus);

  const roleBtn = (r: Role, label: string) => (
    <button
      onClick={() => setRole(r)}
      className={`flex-1 rounded-xl border px-3 py-2.5 text-left transition ${
        role === r
          ? 'border-sky-400/60 bg-sky-500/15'
          : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.08]'
      }`}
    >
      <div className="text-[13px] font-semibold">{label}</div>
      <div className="mt-0.5 font-mono text-[10px] text-slate-400">{PEER_IDS[r]}</div>
    </button>
  );

  return (
    <Panel title="Settings" width="w-[360px]">
      <div className="space-y-4 text-[12px]">
        <section>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
            My identity
          </div>
          <div className="flex gap-2">
            {roleBtn('USER_A', 'User A')}
            {roleBtn('USER_B', 'User B')}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">
            One desk must be User A and the other User B. Switching re-registers this overlay
            under its static peer ID.
          </p>
        </section>
        <section>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
            Connection
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-white/[0.04] px-3 py-2 ring-1 ring-white/10">
            <StatusDot status={status} />
            <span>
              {status === 'CONNECTED' && `Linked with ${partnerOf(role) === 'USER_A' ? 'User A' : 'User B'}`}
              {status === 'CONNECTING' && 'Looking for your partner…'}
              {status === 'DISCONNECTED' && 'Offline'}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">
            Auto-connects whenever both overlays are open — no room codes or pairing steps.
          </p>
        </section>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Speech bubble input (opened by clicking your character)            */
/* ------------------------------------------------------------------ */

function SpeechModal() {
  const current = useAppStore((s) => s.myBubble.text);
  const setMyBubble = useAppStore((s) => s.setMyBubble);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const [draft, setDraft] = useState(current);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setMyBubble(draft);
    setActiveModal('NONE');
  };

  return (
    <Panel title="Say something" width="w-[320px]">
      <form onSubmit={submit} className="space-y-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          maxLength={80}
          placeholder="Type a message…"
          className="w-full rounded-xl bg-white/10 px-3 py-2 text-[13px] outline-none ring-1 ring-white/10 placeholder:text-slate-500 focus:ring-sky-300/50"
        />
        <div className="flex gap-2">
          <button
            type="submit"
            className="flex-1 rounded-xl bg-sky-500/80 py-1.5 text-[12px] font-semibold text-white transition hover:bg-sky-500"
          >
            Say it
          </button>
          <button
            type="button"
            onClick={() => {
              setMyBubble('');
              setActiveModal('NONE');
            }}
            className="rounded-xl bg-white/10 px-3 py-1.5 text-[12px] text-slate-300 transition hover:bg-white/20"
          >
            Clear
          </button>
        </div>
        <p className="text-[10px] text-slate-500">
          Appears over your character for 30 seconds — your partner sees it too.
        </p>
      </form>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Modal layer + status bar                                           */
/* ------------------------------------------------------------------ */

export function ModalLayer() {
  const activeModal = useAppStore((s) => s.activeModal);
  const setActiveModal = useAppStore((s) => s.setActiveModal);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveModal('NONE');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setActiveModal]);

  if (activeModal === 'NONE') return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-3">
      {activeModal === 'NOTEBOOK' && <NotebookModal />}
      {activeModal === 'CORKBOARD' && <CorkboardModal />}
      {activeModal === 'WHITEBOARD' && <WhiteboardModal />}
      {activeModal === 'TIMER' && <TimerModal />}
      {activeModal === 'SETTINGS' && <SettingsModal />}
      {activeModal === 'SPEECH' && <SpeechModal />}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const cls =
    status === 'CONNECTED'
      ? 'bg-emerald-400'
      : status === 'CONNECTING'
        ? 'animate-pulse bg-amber-400'
        : 'bg-rose-400/80';
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${cls}`} />;
}

const STATUS_OPTIONS: Array<{ value: CharacterStatus; icon: string; label: string }> = [
  { value: 'IDLE', icon: '🚶', label: 'Idle — wander around' },
  { value: 'WORKING', icon: '💻', label: 'Working — sit at the desk' },
  { value: 'SLEEPING', icon: '😴', label: 'Sleeping — lie on the bed' },
];

export function StatusBar() {
  const status = useAppStore((s) => s.connectionStatus);
  const role = useAppStore((s) => s.role);
  const activeModal = useAppStore((s) => s.activeModal);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const myStatus = useAppStore((s) => s.myStatus);
  const setMyStatus = useAppStore((s) => s.setMyStatus);

  return (
    <div
      data-interactive
      className="pointer-events-auto absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-slate-900/70 px-3 py-1.5 text-[11px] text-slate-200 shadow-lg backdrop-blur-md"
    >
      <StatusDot status={status} />
      <span className="font-medium">{role === 'USER_A' ? 'User A' : 'User B'}</span>
      <span className="mx-0.5 h-3.5 w-px bg-white/15" />
      {STATUS_OPTIONS.map((o) => (
        <button
          key={o.value}
          onClick={() => setMyStatus(o.value)}
          title={o.label}
          aria-label={o.label}
          className={`rounded-full px-1 text-[13px] leading-none transition ${
            myStatus === o.value ? 'bg-white/25' : 'opacity-55 hover:opacity-100'
          }`}
        >
          {o.icon}
        </button>
      ))}
      <span className="mx-0.5 h-3.5 w-px bg-white/15" />
      <button
        onClick={() => setActiveModal(activeModal === 'SETTINGS' ? 'NONE' : 'SETTINGS')}
        aria-label="Settings"
        className="text-slate-400 transition hover:text-white"
      >
        ⚙
      </button>
    </div>
  );
}
