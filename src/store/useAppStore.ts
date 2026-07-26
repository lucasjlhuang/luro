import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import Peer, { DataConnection } from 'peerjs';

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type Role = 'USER_A' | 'USER_B';
export type ConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';
export type ModalType =
  | 'NONE'
  | 'TIMER'
  | 'NOTEBOOK'
  | 'CORKBOARD'
  | 'WHITEBOARD'
  | 'HABITS'
  | 'SETTINGS'
  | 'SPEECH';
export type TaskStatus = 'TODO' | 'IN_PROGRESS';
export type TimerMode = 'WORK' | 'BREAK';
export type CharacterStatus = 'IDLE' | 'WORKING' | 'SLEEPING';

const VALID_STATUSES: readonly CharacterStatus[] = ['IDLE', 'WORKING', 'SLEEPING'];

/** Guards against stale persisted values / older peers (e.g. removed 'RELAXING'). */
const sanitizeStatus = (status: CharacterStatus): CharacterStatus =>
  VALID_STATUSES.includes(status) ? status : 'IDLE';

export interface Bubble {
  text: string;
  updatedAt: number;
}

/** Live character transform streamed while the partner wanders/drags. */
export interface CharPos {
  x: number;
  z: number;
  yaw: number;
  carried: boolean;
  t: number;
}

export interface Task {
  id: string;
  text: string;
  status: TaskStatus;
  createdAt: number;
}

/** Monday-first, so `days[0]` is Monday and `days[6]` Sunday. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Activity names are kept short so a row fits the grid without wrapping. */
export const HABIT_NAME_MAX = 15;

export interface Habit {
  id: string;
  name: string;
  /** Who added it — the row is colour-coded by author. */
  author: Role;
  /** Seven ticks, Monday..Sunday. */
  days: boolean[];
}

/**
 * The habit board is SHARED, not per-user: one grid both people edit, unlike
 * tasks and notes which are mine/theirs. Resolved last-write-wins on
 * `updatedAt`, the same way the timer and lighting are.
 */
export interface HabitBoard {
  habits: Habit[];
  updatedAt: number;
}

/** Guards against a peer or an old persisted board sending a short row. */
const sanitizeHabits = (board: HabitBoard): HabitBoard => ({
  updatedAt: board?.updatedAt ?? 0,
  habits: (board?.habits ?? []).map((h) => ({
    id: String(h.id),
    name: String(h.name ?? '').slice(0, HABIT_NAME_MAX),
    author: h.author === 'USER_B' ? 'USER_B' : 'USER_A',
    days: Array.from({ length: 7 }, (_, i) => h.days?.[i] === true),
  })),
});

/** A whiteboard stroke; points are normalized [x0, y0, x1, y1, ...] in 0..1. */
export interface Stroke {
  id: string;
  author: Role;
  color: string;
  size: number;
  erase: boolean;
  points: number[];
  t: number;
}

export interface TimerState {
  isRunning: boolean;
  mode: TimerMode;
  /** Epoch ms the countdown finishes; only set while running. */
  endsAt: number | null;
  /** Remaining ms while paused / idle. */
  remainingMs: number;
  workMin: number;
  breakMin: number;
  /** Last-write-wins conflict resolution across peers. */
  updatedAt: number;
}

export const PEER_IDS: Record<Role, string> = {
  USER_A: 'desk-overlay-user-a',
  USER_B: 'desk-overlay-user-b',
};

export const partnerOf = (role: Role): Role => (role === 'USER_A' ? 'USER_B' : 'USER_A');

/* ------------------------------------------------------------------ */
/* Sync protocol                                                      */
/* ------------------------------------------------------------------ */

interface FullSyncPayload {
  role: Role;
  myNotes: string;
  myTasks: Task[];
  strokes: Stroke[];
  isNightMode: boolean;
  lightingUpdatedAt: number;
  timer: TimerState;
  myStatus: CharacterStatus;
  myBubble: Bubble;
  habits: HabitBoard;
}

type SyncMessage =
  | { type: 'NOTE_UPDATE'; payload: string }
  | { type: 'TASK_UPDATE'; payload: Task[] }
  | { type: 'HABITS'; payload: HabitBoard }
  | { type: 'STROKE_ADD'; payload: Stroke }
  | { type: 'WHITEBOARD_CLEAR' }
  | { type: 'LIGHTING'; payload: { isNightMode: boolean; updatedAt: number } }
  | { type: 'TIMER'; payload: TimerState }
  | { type: 'STATUS'; payload: CharacterStatus }
  | { type: 'BUBBLE'; payload: Bubble }
  | { type: 'CHAR_POS'; payload: CharPos }
  | { type: 'FULL_SYNC'; payload: FullSyncPayload };

/* ------------------------------------------------------------------ */
/* Store                                                              */
/* ------------------------------------------------------------------ */

export interface AppState {
  role: Role;
  connectionStatus: ConnectionStatus;
  activeModal: ModalType;

  myNotes: string;
  partnerNotes: string;
  myTasks: Task[];
  partnerTasks: Task[];
  habits: HabitBoard;
  isNightMode: boolean;
  lightingUpdatedAt: number;
  strokes: Stroke[];
  timer: TimerState;
  /** Last pen colour the local user drew with (mirrored by the 3D marker). */
  penColor: string;
  myStatus: CharacterStatus;
  partnerStatus: CharacterStatus;
  /** Ephemeral speech bubbles (not persisted; expire client-side). */
  myBubble: Bubble;
  partnerBubble: Bubble;
  /** Last received partner character transform (ephemeral). */
  partnerCharPos: CharPos | null;

  initPeer: () => void;
  setRole: (role: Role) => void;
  setActiveModal: (modal: ModalType) => void;

  setMyNotes: (text: string) => void;
  addTask: (text: string) => void;
  updateTaskStatus: (id: string, status: TaskStatus) => void;
  addHabit: (name: string) => void;
  renameHabit: (id: string, name: string) => void;
  toggleHabitDay: (id: string, day: number) => void;
  deleteHabit: (id: string) => void;
  deleteTask: (id: string) => void;
  toggleNightMode: () => void;
  addLocalStroke: (stroke: Omit<Stroke, 'id' | 'author' | 't'>) => void;
  clearWhiteboard: () => void;
  setPenColor: (color: string) => void;
  setMyStatus: (status: CharacterStatus) => void;
  setMyBubble: (text: string) => void;
  /** Fire-and-forget position broadcast; does not touch local state. */
  sendCharPos: (pos: Omit<CharPos, 't'>) => void;

  startTimer: () => void;
  pauseTimer: () => void;
  resetTimer: () => void;
  setTimerMode: (mode: TimerMode) => void;
  setTimerDurations: (workMin: number, breakMin: number) => void;
}

const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const durationMsFor = (mode: TimerMode, timer: TimerState): number =>
  (mode === 'WORK' ? timer.workMin : timer.breakMin) * 60_000;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      role: 'USER_A',
      connectionStatus: 'DISCONNECTED',
      activeModal: 'NONE',

      myNotes: '',
      partnerNotes: '',
      myTasks: [],
      habits: { habits: [], updatedAt: 0 },
      partnerTasks: [],
      isNightMode: false,
      lightingUpdatedAt: 0,
      strokes: [],
      penColor: '#1e293b',
      myStatus: 'IDLE',
      partnerStatus: 'IDLE',
      myBubble: { text: '', updatedAt: 0 },
      partnerBubble: { text: '', updatedAt: 0 },
      partnerCharPos: null,
      timer: {
        isRunning: false,
        mode: 'WORK',
        endsAt: null,
        remainingMs: 25 * 60_000,
        workMin: 25,
        breakMin: 5,
        updatedAt: 0,
      },

      initPeer: () => startEngine(),

      setRole: (role) => {
        if (role === get().role) return;
        set({ role, connectionStatus: 'DISCONNECTED' });
        // Re-register on the signalling server under the new static ID.
        createPeer();
      },

      setActiveModal: (modal) => set({ activeModal: modal }),

      setMyNotes: (text) => {
        set({ myNotes: text });
        broadcast({ type: 'NOTE_UPDATE', payload: text });
      },

      /* Habits are a single shared board: every edit republishes the whole
         thing with a fresh timestamp, and the peer takes it if it is newer.
         Same last-write-wins as the timer — simultaneous edits on both ends
         can drop one, which is fine for two people and one small grid. */
      addHabit: (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set({
          habits: {
            habits: [
              ...get().habits.habits,
              {
                id: uid(),
                name: trimmed.slice(0, HABIT_NAME_MAX),
                author: get().role,
                days: Array.from({ length: 7 }, () => false),
              },
            ],
            updatedAt: Date.now(),
          },
        });
        broadcast({ type: 'HABITS', payload: get().habits });
      },

      renameHabit: (id, name) => {
        set({
          habits: {
            habits: get().habits.habits.map((h) =>
              h.id === id ? { ...h, name: name.slice(0, HABIT_NAME_MAX) } : h
            ),
            updatedAt: Date.now(),
          },
        });
        broadcast({ type: 'HABITS', payload: get().habits });
      },

      toggleHabitDay: (id, day) => {
        if (day < 0 || day > 6) return;
        set({
          habits: {
            habits: get().habits.habits.map((h) =>
              h.id === id ? { ...h, days: h.days.map((d, i) => (i === day ? !d : d)) } : h
            ),
            updatedAt: Date.now(),
          },
        });
        broadcast({ type: 'HABITS', payload: get().habits });
      },

      deleteHabit: (id) => {
        set({
          habits: {
            habits: get().habits.habits.filter((h) => h.id !== id),
            updatedAt: Date.now(),
          },
        });
        broadcast({ type: 'HABITS', payload: get().habits });
      },

      addTask: (text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const myTasks: Task[] = [
          ...get().myTasks,
          { id: uid(), text: trimmed, status: 'TODO', createdAt: Date.now() },
        ];
        set({ myTasks });
        broadcast({ type: 'TASK_UPDATE', payload: myTasks });
      },

      updateTaskStatus: (id, status) => {
        const myTasks = get().myTasks.map((t) => (t.id === id ? { ...t, status } : t));
        set({ myTasks });
        broadcast({ type: 'TASK_UPDATE', payload: myTasks });
      },

      deleteTask: (id) => {
        const myTasks = get().myTasks.filter((t) => t.id !== id);
        set({ myTasks });
        broadcast({ type: 'TASK_UPDATE', payload: myTasks });
      },

      toggleNightMode: () => {
        const isNightMode = !get().isNightMode;
        const lightingUpdatedAt = Date.now();
        set({ isNightMode, lightingUpdatedAt });
        broadcast({ type: 'LIGHTING', payload: { isNightMode, updatedAt: lightingUpdatedAt } });
      },

      addLocalStroke: (partial) => {
        const stroke: Stroke = { ...partial, id: uid(), author: get().role, t: Date.now() };
        set({ strokes: [...get().strokes, stroke] });
        broadcast({ type: 'STROKE_ADD', payload: stroke });
      },

      clearWhiteboard: () => {
        set({ strokes: [] });
        broadcast({ type: 'WHITEBOARD_CLEAR' });
      },

      setPenColor: (color) => set({ penColor: color }),

      setMyStatus: (status) => {
        set({ myStatus: status });
        broadcast({ type: 'STATUS', payload: status });
      },

      setMyBubble: (text) => {
        const myBubble: Bubble = { text: text.trim(), updatedAt: Date.now() };
        set({ myBubble });
        broadcast({ type: 'BUBBLE', payload: myBubble });
      },

      sendCharPos: (pos) => {
        broadcast({ type: 'CHAR_POS', payload: { ...pos, t: Date.now() } });
      },

      startTimer: () => {
        const t = get().timer;
        if (t.isRunning) return;
        const remaining = t.remainingMs > 500 ? t.remainingMs : durationMsFor(t.mode, t);
        const timer: TimerState = {
          ...t,
          isRunning: true,
          endsAt: Date.now() + remaining,
          remainingMs: remaining,
          updatedAt: Date.now(),
        };
        set({ timer });
        broadcast({ type: 'TIMER', payload: timer });
      },

      pauseTimer: () => {
        const t = get().timer;
        if (!t.isRunning || t.endsAt === null) return;
        const timer: TimerState = {
          ...t,
          isRunning: false,
          remainingMs: Math.max(0, t.endsAt - Date.now()),
          endsAt: null,
          updatedAt: Date.now(),
        };
        set({ timer });
        broadcast({ type: 'TIMER', payload: timer });
      },

      resetTimer: () => {
        const t = get().timer;
        const timer: TimerState = {
          ...t,
          isRunning: false,
          endsAt: null,
          remainingMs: durationMsFor(t.mode, t),
          updatedAt: Date.now(),
        };
        set({ timer });
        broadcast({ type: 'TIMER', payload: timer });
      },

      setTimerMode: (mode) => {
        const t = get().timer;
        const timer: TimerState = {
          ...t,
          mode,
          isRunning: false,
          endsAt: null,
          remainingMs: durationMsFor(mode, t),
          updatedAt: Date.now(),
        };
        set({ timer });
        broadcast({ type: 'TIMER', payload: timer });
      },

      setTimerDurations: (workMin, breakMin) => {
        const t = get().timer;
        const next: TimerState = {
          ...t,
          workMin: clamp(workMin, 5, 90),
          breakMin: clamp(breakMin, 1, 30),
          updatedAt: Date.now(),
        };
        if (!next.isRunning) next.remainingMs = durationMsFor(next.mode, next);
        set({ timer: next });
        broadcast({ type: 'TIMER', payload: next });
      },
    }),
    {
      name: 'desk-overlay-storage',
      partialize: (s) => ({
        role: s.role,
        myNotes: s.myNotes,
        partnerNotes: s.partnerNotes,
        myTasks: s.myTasks,
        partnerTasks: s.partnerTasks,
        habits: s.habits,
        isNightMode: s.isNightMode,
        lightingUpdatedAt: s.lightingUpdatedAt,
        strokes: s.strokes,
        penColor: s.penColor,
        myStatus: s.myStatus,
        partnerStatus: s.partnerStatus,
        timer: s.timer,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // A timer persisted mid-run is stale after a restart; freeze it.
        if (state.timer.isRunning) {
          const remaining = state.timer.endsAt ? Math.max(0, state.timer.endsAt - Date.now()) : 0;
          useAppStore.setState({
            timer: { ...state.timer, isRunning: false, endsAt: null, remainingMs: remaining },
          });
        }
        // A board persisted by an older build may predate the habit grid.
        useAppStore.setState({
          habits: sanitizeHabits(state.habits ?? { habits: [], updatedAt: 0 }),
        });
        // Statuses persisted by an older build may no longer exist.
        useAppStore.setState({
          myStatus: sanitizeStatus(state.myStatus),
          partnerStatus: sanitizeStatus(state.partnerStatus),
        });
      },
    }
  )
);

/* ------------------------------------------------------------------ */
/* PeerJS auto-connect engine                                         */
/*                                                                    */
/* Both roles register under a static, well-known peer ID and keep    */
/* dialing the partner ID until a data channel opens — no room codes. */
/* Peer/connection objects are module-level singletons (never put     */
/* non-serializable network handles inside persisted state).          */
/* ------------------------------------------------------------------ */

let peer: Peer | null = null;
const conns = new Set<DataConnection>();
let retryTimer: ReturnType<typeof setInterval> | null = null;
let recreateTimer: ReturnType<typeof setTimeout> | null = null;
let engineStarted = false;

function startEngine(): void {
  if (engineStarted) return;
  engineStarted = true;
  createPeer();
}

function destroyPeer(): void {
  if (retryTimer !== null) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  if (recreateTimer !== null) {
    clearTimeout(recreateTimer);
    recreateTimer = null;
  }
  conns.forEach((c) => {
    try {
      c.close();
    } catch {
      /* already closed */
    }
  });
  conns.clear();
  if (peer) {
    try {
      peer.destroy();
    } catch {
      /* already destroyed */
    }
    peer = null;
  }
}

function createPeer(): void {
  destroyPeer();
  const { role } = useAppStore.getState();
  useAppStore.setState({ connectionStatus: 'CONNECTING' });

  const p = new Peer(PEER_IDS[role], { debug: 0 });
  peer = p;

  p.on('open', () => {
    tryConnect();
    retryTimer = setInterval(tryConnect, 4000);
  });

  // The partner dialed us — same channel, opposite direction.
  p.on('connection', (c) => wireConnection(c));

  p.on('disconnected', () => {
    if (peer === p && !p.destroyed) {
      try {
        p.reconnect();
      } catch {
        /* fatal state; recreate below via error handler */
      }
    }
  });

  p.on('error', (err) => {
    const type = (err as { type?: string }).type;
    if (type === 'unavailable-id') {
      // Another instance holds our static ID (both desks set the same role).
      useAppStore.setState({ connectionStatus: 'DISCONNECTED' });
      recreateTimer = setTimeout(() => {
        if (peer === p) createPeer();
      }, 6000);
    }
    // 'peer-unavailable' just means the partner is offline; the retry
    // interval keeps dialing until they appear.
  });
}

function tryConnect(): void {
  if (!peer || peer.destroyed || !peer.open) return;
  if ([...conns].some((c) => c.open)) return;
  const { role } = useAppStore.getState();
  wireConnection(peer.connect(PEER_IDS[partnerOf(role)], { reliable: true }));
}

function refreshStatus(): void {
  const open = [...conns].some((c) => c.open);
  useAppStore.setState({
    connectionStatus: open ? 'CONNECTED' : peer && !peer.destroyed ? 'CONNECTING' : 'DISCONNECTED',
  });
}

function wireConnection(c: DataConnection): void {
  conns.add(c);
  c.on('open', () => {
    refreshStatus();
    c.send(buildFullSync());
  });
  c.on('data', (data) => handleMessage(data as SyncMessage));
  c.on('close', () => {
    conns.delete(c);
    refreshStatus();
  });
  c.on('error', () => {
    conns.delete(c);
    refreshStatus();
  });
}

function broadcast(msg: SyncMessage): void {
  conns.forEach((c) => {
    if (c.open) c.send(msg);
  });
}

function buildFullSync(): SyncMessage {
  const s = useAppStore.getState();
  return {
    type: 'FULL_SYNC',
    payload: {
      role: s.role,
      myNotes: s.myNotes,
      myTasks: s.myTasks,
      strokes: s.strokes,
      isNightMode: s.isNightMode,
      lightingUpdatedAt: s.lightingUpdatedAt,
      timer: s.timer,
      myStatus: s.myStatus,
      myBubble: s.myBubble,
      habits: s.habits,
    },
  };
}

function mergeStrokes(local: Stroke[], incoming: Stroke[]): Stroke[] {
  const byId = new Map<string, Stroke>();
  for (const s of [...local, ...incoming]) {
    if (!byId.has(s.id)) byId.set(s.id, s);
  }
  return [...byId.values()].sort((a, b) => a.t - b.t);
}

function handleMessage(msg: SyncMessage): void {
  switch (msg.type) {
    case 'NOTE_UPDATE':
      useAppStore.setState({ partnerNotes: msg.payload });
      break;
    case 'TASK_UPDATE':
      useAppStore.setState({ partnerTasks: msg.payload });
      break;
    case 'HABITS':
      useAppStore.setState((s) =>
        msg.payload.updatedAt >= s.habits.updatedAt ? { habits: sanitizeHabits(msg.payload) } : {}
      );
      break;
    case 'STROKE_ADD':
      useAppStore.setState((s) =>
        s.strokes.some((x) => x.id === msg.payload.id)
          ? {}
          : { strokes: mergeStrokes(s.strokes, [msg.payload]) }
      );
      break;
    case 'WHITEBOARD_CLEAR':
      useAppStore.setState({ strokes: [] });
      break;
    case 'LIGHTING':
      useAppStore.setState((s) =>
        msg.payload.updatedAt >= s.lightingUpdatedAt
          ? { isNightMode: msg.payload.isNightMode, lightingUpdatedAt: msg.payload.updatedAt }
          : {}
      );
      break;
    case 'TIMER':
      useAppStore.setState((s) => (msg.payload.updatedAt >= s.timer.updatedAt ? { timer: msg.payload } : {}));
      break;
    case 'STATUS':
      useAppStore.setState({ partnerStatus: sanitizeStatus(msg.payload) });
      break;
    case 'BUBBLE':
      useAppStore.setState({ partnerBubble: msg.payload });
      break;
    case 'CHAR_POS':
      useAppStore.setState({ partnerCharPos: msg.payload });
      break;
    case 'FULL_SYNC': {
      const p = msg.payload;
      useAppStore.setState((s) => ({
        partnerNotes: p.myNotes,
        partnerTasks: p.myTasks,
        partnerStatus: sanitizeStatus(p.myStatus),
        partnerBubble: p.myBubble,
        strokes: mergeStrokes(s.strokes, p.strokes),
        ...(p.lightingUpdatedAt > s.lightingUpdatedAt
          ? { isNightMode: p.isNightMode, lightingUpdatedAt: p.lightingUpdatedAt }
          : {}),
        ...(p.timer.updatedAt > s.timer.updatedAt ? { timer: p.timer } : {}),
        ...((p.habits?.updatedAt ?? 0) > s.habits.updatedAt
          ? { habits: sanitizeHabits(p.habits) }
          : {}),
      }));
      break;
    }
  }
}
