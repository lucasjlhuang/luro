import {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Role, useAppStore } from '../../store/useAppStore';
import { renderStrokes } from '../../lib/strokes';
import { CURSOR, lockCursor, setCursor, unlockCursor } from '../../lib/cursors';
import { setForceInteractive } from '../../lib/hitTest';
import { getPan } from '../../lib/pan';

/* ------------------------------------------------------------------ */
/* Panel chrome palette — mirrors the 3D room's materials so each     */
/* menu reads as a blown-up version of the object that opened it.     */
/* ------------------------------------------------------------------ */

const WOOD = '#d9a563';
const WOOD_DARK = '#c99a5f';
const ORANGE = '#ee7d3c';
const CREAM = '#f6ecca';
const CREAM_SOFT = '#efe2ba';

/* ------------------------------------------------------------------ */
/* Shared drag behaviour: every panel is draggable by its chrome and  */
/* remembers its position for the session.                            */
/* ------------------------------------------------------------------ */

const panelPositions = new Map<string, { x: number; y: number }>();

function useDragPanel(id: string) {
  // First open lands beside the room (wherever it's panned); after
  // that, each panel remembers where the user dragged it.
  const [pos, setPos] = useState(() => panelPositions.get(id) ?? { ...getPan() });

  const startDrag = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    // Controls keep their own behaviour; only the chrome drags.
    if ((e.target as HTMLElement).closest('button, input, textarea, canvas, select, a')) return;
    e.preventDefault();
    const originX = e.clientX - pos.x;
    const originY = e.clientY - pos.y;
    setForceInteractive(true);
    lockCursor(CURSOR.grab);
    const onMove = (ev: PointerEvent) => {
      const limX = window.innerWidth / 2 - 30;
      const limY = window.innerHeight / 2 - 30;
      const next = {
        x: Math.max(-limX, Math.min(limX, ev.clientX - originX)),
        y: Math.max(-limY, Math.min(limY, ev.clientY - originY)),
      };
      panelPositions.set(id, next);
      setPos(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setForceInteractive(false);
      unlockCursor();
      setCursor(CURSOR.open);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return { pos, startDrag };
}

function DragShell({
  id,
  className = '',
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  const { pos, startDrag } = useDragPanel(id);
  return (
    <div
      data-interactive
      data-drag-handle
      onPointerDown={startDrag}
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
      className={`pointer-events-auto relative select-none ${className}`}
    >
      {children}
    </div>
  );
}

function CloseButton({ bg = WOOD_DARK, fg = '#ffffff' }: { bg?: string; fg?: string }) {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  return (
    <button
      onClick={() => setActiveModal('NONE')}
      aria-label="Close"
      className="absolute -right-2 -top-2 z-20 flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold shadow-md transition hover:brightness-110"
      style={{ background: bg, color: fg }}
    >
      ✕
    </button>
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
        <code key={key} className="rounded bg-black/10 px-1 text-[11px]">
          {part.slice(1, -1)}
        </code>
      );
    return <span key={key}>{part}</span>;
  });
}

/** Blinking caret shown wherever a page is still empty. */
function TypingCaret() {
  return <span className="inline-block h-4 w-[2px] animate-pulse bg-[#4a3c28]" />;
}

function MarkdownView({ source }: { source: string }) {
  if (!source.trim()) {
    return <TypingCaret />;
  }
  return (
    <div className="space-y-1 text-[12px] leading-5 text-[#4a3c28]">
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
              <span className="text-[#a08a66]">•</span>
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
/* Notebook: orange cover, two ruled paper pages, centre spine        */
/* ------------------------------------------------------------------ */

const RULED_LINES = {
  backgroundImage:
    'repeating-linear-gradient(to bottom, transparent 0px, transparent 19px, rgba(90,70,40,0.14) 19px, rgba(90,70,40,0.14) 20px)',
  backgroundPositionY: '6px',
};

const WORLD_NAMES: Record<Role, string> = {
  USER_A: "Lulu's World",
  USER_B: "Roro's World",
};

function NotebookModal() {
  const myNotes = useAppStore((s) => s.myNotes);
  const setMyNotes = useAppStore((s) => s.setMyNotes);
  const partnerNotes = useAppStore((s) => s.partnerNotes);
  const role = useAppStore((s) => s.role);
  const partnerRole: Role = role === 'USER_A' ? 'USER_B' : 'USER_A';

  return (
    <DragShell id="notebook">
      <div className="relative rounded-2xl p-3 shadow-xl" style={{ background: ORANGE }}>
        <CloseButton bg="#c9622a" />
        <div className="flex h-[320px] w-[452px] overflow-hidden rounded-lg shadow-inner">
          <div className="flex flex-1 flex-col p-3" style={{ background: CREAM, ...RULED_LINES }}>
            <div className="mb-1 text-[9px] font-bold uppercase tracking-widest text-[#a08a66]">
              {WORLD_NAMES[role]}
            </div>
            <div className="relative flex flex-1">
              <textarea
                value={myNotes}
                onChange={(e) => setMyNotes(e.target.value)}
                spellCheck={false}
                className="flex-1 resize-none bg-transparent font-mono text-[12px] leading-5 text-[#4a3c28] outline-none"
              />
              {myNotes === '' && (
                <span className="pointer-events-none absolute left-0 top-0.5">
                  <TypingCaret />
                </span>
              )}
            </div>
          </div>
          <div className="w-[5px] shrink-0" style={{ background: 'linear-gradient(90deg, rgba(0,0,0,0.16), rgba(0,0,0,0.02))' }} />
          <div className="flex flex-1 flex-col overflow-hidden p-3" style={{ background: '#f9f4e8', ...RULED_LINES }}>
            <div className="mb-1 text-[9px] font-bold uppercase tracking-widest text-[#a08a66]">
              {WORLD_NAMES[partnerRole]}
            </div>
            <div className="flex-1 overflow-y-auto pr-1">
              <MarkdownView source={partnerNotes} />
            </div>
          </div>
        </div>
      </div>
    </DragShell>
  );
}

/* ------------------------------------------------------------------ */
/* Corkboard: wood frame, cork surface, tasks as pinned sticky notes  */
/* ------------------------------------------------------------------ */

function noteTilt(id: string): number {
  return ((id.charCodeAt(0) + id.length) % 5) - 2;
}

function StickyNote({
  color,
  tilt,
  children,
  actions,
}: {
  color: string;
  tilt: number;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      className="group relative px-2 pb-1.5 pt-3 text-[11px] leading-snug text-[#5b4a32] shadow-md"
      style={{ background: color, transform: `rotate(${tilt}deg)` }}
    >
      <span className="absolute left-1/2 top-1 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-red-500/80 shadow-sm" />
      <div className="break-words">{children}</div>
      {actions && (
        <div className="mt-1 flex justify-end gap-0.5 opacity-0 transition group-hover:opacity-100">
          {actions}
        </div>
      )}
    </div>
  );
}

function NoteButton({ label, onClick, title }: { label: string; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded bg-black/10 px-1 text-[10px] text-[#5b4a32] transition hover:bg-black/20"
    >
      {label}
    </button>
  );
}

function TapeLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto mb-1.5 w-max -rotate-2 bg-white/75 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-[#8a6b45] shadow-sm">
      {children}
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
  const listCls = 'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1 pb-1 pt-0.5';

  return (
    <DragShell id="corkboard">
      <div className="relative rounded-2xl p-3 shadow-xl" style={{ background: WOOD }}>
        <CloseButton />
        <div
          className="grid h-[310px] w-[452px] grid-cols-3 gap-2 rounded-lg p-2.5 shadow-inner"
          style={{
            background: CREAM_SOFT,
            backgroundImage: 'radial-gradient(rgba(120,90,50,0.10) 1px, transparent 1px)',
            backgroundSize: '9px 9px',
          }}
        >
          <section className="flex min-h-0 flex-col">
            <TapeLabel>To Do · {todo.length}</TapeLabel>
            <form
              onSubmit={submit}
              className="relative mb-2 rotate-1 px-2 pb-1.5 pt-3 shadow-md"
              style={{ background: '#ffe66b' }}
            >
              <span className="absolute left-1/2 top-1 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-red-500/80 shadow-sm" />
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Add task…"
                className="w-full bg-transparent text-[11px] text-[#6b5b2a] outline-none placeholder:text-[#a89a5e]"
              />
            </form>
            <div className={listCls}>
              {todo.map((t) => (
                <StickyNote
                  key={t.id}
                  color="#ffe66b"
                  tilt={noteTilt(t.id)}
                  actions={
                    <>
                      <NoteButton label="→" title="Start" onClick={() => updateTaskStatus(t.id, 'IN_PROGRESS')} />
                      <NoteButton label="✕" title="Delete" onClick={() => deleteTask(t.id)} />
                    </>
                  }
                >
                  {t.text}
                </StickyNote>
              ))}
            </div>
          </section>

          <section className="flex min-h-0 flex-col">
            <TapeLabel>In Progress · {doing.length}</TapeLabel>
            <div className={listCls}>
              {doing.map((t) => (
                <StickyNote
                  key={t.id}
                  color="#a8d8ea"
                  tilt={noteTilt(t.id)}
                  actions={
                    <>
                      <NoteButton label="←" title="Back to To Do" onClick={() => updateTaskStatus(t.id, 'TODO')} />
                      <NoteButton label="✓" title="Done (remove)" onClick={() => deleteTask(t.id)} />
                    </>
                  }
                >
                  {t.text}
                </StickyNote>
              ))}
            </div>
          </section>

          <section className="flex min-h-0 flex-col">
            <TapeLabel>Partner · {partnerTasks.length}</TapeLabel>
            <div className={listCls}>
              {partnerTasks.map((t) => (
                <StickyNote key={t.id} color="#f9c1d0" tilt={noteTilt(t.id)}>
                  <span className="text-[#6b3a4a]">{t.text}</span>
                  <div className="mt-0.5 text-[8px] font-bold uppercase tracking-wider text-[#6b3a4a]/70">
                    {t.status === 'IN_PROGRESS' ? 'in progress' : 'to do'}
                  </div>
                </StickyNote>
              ))}
            </div>
          </section>
        </div>
      </div>
    </DragShell>
  );
}

/* ------------------------------------------------------------------ */
/* Whiteboard: wood frame, white surface, marker tray as the toolbar  */
/* ------------------------------------------------------------------ */

const PEN_COLORS = ['#1e293b', '#dc2626', '#2563eb', '#16a34a', '#d97706', '#9333ea'];
const PEN_SIZES = [2, 4, 8];
const BOARD_W = 460;
const BOARD_H = 288;
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

  // While erasing, the cursor over the board is the eraser block itself,
  // sized to the eraser stroke.
  const eraserCursor = useMemo(() => {
    if (!eraser) return undefined;
    const w = Math.max(20, size * 3 * 1.8);
    const h = Math.max(12, size * 3);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return undefined;
    ctx.fillStyle = '#4b5563';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(1, 1, w - 2, h - 2, 3);
    ctx.fill();
    ctx.stroke();
    return `url(${c.toDataURL()}) ${Math.round(w / 2)} ${Math.round(h / 2)}, cell`;
  }, [eraser, size]);

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
      ctx.lineCap = eraser ? 'square' : 'round';
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
    <DragShell id="whiteboard">
      {/* wood frame + surface */}
      <div className="relative rounded-2xl p-3 shadow-xl" style={{ background: WOOD }}>
        <CloseButton />
        <canvas
          ref={canvasRef}
          data-draw
          width={BOARD_W * BOARD_SCALE}
          height={BOARD_H * BOARD_SCALE}
          style={{ width: BOARD_W, height: BOARD_H, ...(eraserCursor ? { cursor: eraserCursor } : {}) }}
          className="touch-none rounded-lg bg-white shadow-inner"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      </div>
      {/* marker tray = the toolbar */}
      <div
        className="mx-auto -mt-1.5 flex h-12 w-[70%] items-center justify-center gap-2.5 rounded-b-xl px-3 shadow-lg"
        style={{ background: WOOD_DARK }}
      >
        <div className="flex items-end gap-1.5">
          {PEN_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => {
                setColor(c);
                setEraser(false);
              }}
              title={`Marker ${c}`}
              aria-label={`Pen color ${c}`}
              className={`relative h-7 w-3.5 rounded-[3px] shadow-sm transition-transform ${
                !eraser && color === c ? '-translate-y-1.5' : 'hover:-translate-y-0.5'
              }`}
              style={{ background: c }}
            >
              <span className="absolute inset-x-0 top-0 h-2 rounded-t-[3px] bg-black/30" />
            </button>
          ))}
        </div>
        <div className="h-6 w-px bg-black/15" />
        <div className="flex items-center gap-1">
          {PEN_SIZES.map((s) => (
            <button
              key={s}
              onClick={() => setSize(s)}
              aria-label={`Pen size ${s}`}
              className={`flex h-5 w-5 items-center justify-center rounded transition ${
                size === s ? 'bg-black/25' : 'bg-black/10 hover:bg-black/20'
              }`}
            >
              <span className="rounded-full bg-white" style={{ width: s + 1, height: s + 1 }} />
            </button>
          ))}
        </div>
        <button
          onClick={() => setEraser((v) => !v)}
          title="Eraser"
          className={`h-5 w-9 rounded-sm bg-slate-600 shadow-sm transition ${
            eraser ? '-translate-y-1 ring-2 ring-white/70' : 'hover:-translate-y-0.5'
          }`}
        />
        <button
          onClick={clearWhiteboard}
          className="rounded bg-red-500/80 px-1.5 py-0.5 text-[10px] font-semibold text-white transition hover:bg-red-500"
        >
          Clear
        </button>
      </div>
    </DragShell>
  );
}

/* ------------------------------------------------------------------ */
/* Timer: the alarm clock itself — bells, orange body, cream bezel,   */
/* dark screen with amber digits, little feet                         */
/* ------------------------------------------------------------------ */

function TimerModal() {
  const timer = useAppStore((s) => s.timer);
  const startTimer = useAppStore((s) => s.startTimer);
  const pauseTimer = useAppStore((s) => s.pauseTimer);
  const resetTimer = useAppStore((s) => s.resetTimer);

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

  return (
    <DragShell id="timer" className="w-[300px]">
      {/* twin bells peeking from behind the body */}
      <div className="absolute -top-4 left-9 h-10 w-10 rounded-full shadow" style={{ background: '#e0b25c', border: '3px solid #c9a04e' }} />
      <div className="absolute -top-4 right-9 h-10 w-10 rounded-full shadow" style={{ background: '#e0b25c', border: '3px solid #c9a04e' }} />
      {/* feet */}
      <div className="absolute -bottom-2 left-8 h-4 w-7 rounded-b-lg shadow" style={{ background: WOOD_DARK }} />
      <div className="absolute -bottom-2 right-8 h-4 w-7 rounded-b-lg shadow" style={{ background: WOOD_DARK }} />

      {/* body */}
      <div className="relative rounded-[26px] p-3 shadow-xl" style={{ background: ORANGE }}>
        <CloseButton bg="#c9622a" />
        {/* cream bezel */}
        <div className="space-y-2.5 rounded-2xl p-3" style={{ background: CREAM }}>
          {/* white face, black digits, pink progress */}
          <div className="rounded-xl bg-white px-3 pb-2.5 pt-1 text-center shadow-inner ring-1 ring-black/10">
            <div
              className={`font-mono text-[46px] font-bold leading-tight tabular-nums text-[#1a1a1a] ${done ? 'animate-pulse' : ''}`}
            >
              {mm}:{ss}
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-black/5">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${totalMs > 0 ? (remaining / totalMs) * 100 : 0}%`,
                  background: '#f9c1d0',
                }}
              />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={timer.isRunning ? pauseTimer : startTimer}
              className="flex-1 rounded-xl py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
              style={{ background: ORANGE }}
            >
              {timer.isRunning ? 'Pause' : 'Start'}
            </button>
            <button
              onClick={resetTimer}
              className="rounded-xl bg-black/10 px-4 py-2 text-sm text-[#7a4a1e] transition hover:bg-black/15"
            >
              Reset
            </button>
          </div>
        </div>
      </div>
    </DragShell>
  );
}

/* ------------------------------------------------------------------ */
/* Settings + speech input keep the clean white glass                 */
/* ------------------------------------------------------------------ */

function GlassPanel({
  id,
  title,
  width = 'w-[360px]',
  children,
}: {
  id: string;
  title: string;
  width?: string;
  children: ReactNode;
}) {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const { pos, startDrag } = useDragPanel(id);
  return (
    <div
      data-interactive
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
      className={`pointer-events-auto flex flex-col rounded-2xl border border-white/60 bg-white/65 text-slate-700 shadow-xl backdrop-blur-2xl ${width}`}
    >
      <div
        data-drag-handle
        onPointerDown={startDrag}
        className="flex select-none items-center justify-between border-b border-slate-900/10 px-4 py-2.5"
      >
        <h2 className="text-sm font-semibold tracking-wide text-slate-600">{title}</h2>
        <button
          onClick={() => setActiveModal('NONE')}
          aria-label="Close"
          className="rounded-md px-2 py-0.5 text-slate-400 transition hover:bg-slate-900/10 hover:text-slate-700"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-hidden p-3">{children}</div>
    </div>
  );
}

function SettingsModal() {
  const role = useAppStore((s) => s.role);
  const setRole = useAppStore((s) => s.setRole);

  const roleBtn = (r: Role, label: string) => (
    <button
      onClick={() => setRole(r)}
      className={`flex-1 rounded-xl border px-3 py-2.5 text-center text-[13px] font-semibold text-slate-700 transition ${
        role === r
          ? 'border-sky-500/60 bg-sky-500/10'
          : 'border-slate-900/10 bg-white/50 hover:bg-white/80'
      }`}
    >
      {label}
    </button>
  );

  return (
    <GlassPanel id="settings" title="Settings" width="w-[300px]">
      <div className="flex gap-2">
        {roleBtn('USER_A', 'User A (Lulu)')}
        {roleBtn('USER_B', 'User B (Roro)')}
      </div>
    </GlassPanel>
  );
}

/* ------------------------------------------------------------------ */
/* Modal layer                                                        */
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
      {/* SPEECH renders in-scene as an editable bubble over the character */}
    </div>
  );
}
