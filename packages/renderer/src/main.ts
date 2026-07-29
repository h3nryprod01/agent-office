import { t } from "./i18n";
import { INITIAL_STATE, type OfficeState } from "./sim/model";
import { reduce } from "./sim/reducer";
import { filterStateByRepo } from "./sim/selectors";
import { createOffice3D, type Office3DHandle } from "./render3d/Office3D";
import { initialQuality, watchQuality } from "./render3d/quality";
import { scrumSummary, type WallBoardData } from "./ui/wallBoardData";
import { MockEventSource } from "./events/MockEventSource";
import { WebSocketEventSource, wsBase } from "./events/WebSocketEventSource";
import { buildScenario } from "./events/scenario";
import { mountControls } from "./ui/controls";
import { mountSidePanel } from "./ui/sidePanel";
import { mountBoard } from "./ui/board";
import { mountCosts, type CostWindow, type CostsPayload } from "./ui/costs";
import { mountOutputs, type OutputFile } from "./ui/outputs";
import type { WorkItemsFile } from "./ui/workItems";
import { mountNavbar, type NavItem } from "./ui/navbar";
import { mountKanban, type KanbanItem } from "./ui/kanban";
import { mountActivityLog, type TranscriptRow } from "./ui/activityLog";
import { mountSettings, type HarnessStatus } from "./ui/settings";
import { mountInterventionQueue } from "./ui/interventionQueue";
import { mountNotifier } from "./ui/notify";
import { mountOrgChart } from "./ui/orgchart";
import { mountBuildingView } from "./ui/buildingView";
import { ApprovalsStore } from "./ui/approvals";
import { mountOfficeTabs, TAB_ALL, type TabKey } from "./ui/officeTabs";
import { mountTimelineBar, type ReplayView } from "./ui/timelineBar";
import { mountChatBox, type ChatBoxHandle } from "./ui/chatBox";
import { mountHiringHall, type HiringHallHandle, type RosterPayload } from "./ui/hiringHall";
import { mountTemplates, type ApplyResult, type TemplateSummary } from "./ui/templates";
import { EventRecorder } from "./replay/recorder";
import { createSfx } from "./audio/sfx";
import type { EventSource } from "./events/EventSource";

/** "" = the All tab's office; otherwise the repo name. */
const ALL_KEY = "";
const keyOf = (tab: TabKey): string => (tab.kind === "all" ? ALL_KEY : tab.repo);

async function boot(): Promise<void> {
  // The office is 3D (Phase 4 cutover complete — Pixi is gone). One scene, fed
  // the repo-filtered state; the tab filter is what makes desks per-repo.
  //
  // It is allowed to fail. WebGL can be missing or blocked (old GPU, driver,
  // remote desktop, a VM without acceleration) and THREE.WebGLRenderer throws on
  // construction. This is the first thing boot() does, so an unguarded throw
  // would take the WHOLE app down — navbar, Bảng việc, Nhật ký, Chi phí, Cấu
  // hình — leaving a blank page. The office is the nice-to-have; those panels
  // are the job. So: degrade to a message and keep going.
  let office3d: Office3DHandle | null = null;
  try {
    office3d = createOffice3D({
      onPick: (agentId) => sidePanel.show(agentId),
      onFurniture: (id) => { if (id === "filing_cabinet") outputsPanel.show(); },
    });
    document.querySelector<HTMLElement>("#app")!.appendChild(office3d.canvas);
    office3d.resize();
    addEventListener("resize", () => office3d?.resize());
  } catch (err) {
    console.warn("[office] 3D unavailable — falling back to panels only:", err);
    const host = document.querySelector<HTMLElement>("#app")!;
    const box = document.createElement("div");
    box.className = "office-fallback";
    box.innerHTML =
      `<h2>${t("webgl.title")}</h2>` +
      `<p>${t("webgl.body")}</p>` +
      `<p>${t("webgl.stillWorks")}</p>` +
      `<p class="hint">${t("webgl.hint")}</p>`;
    host.appendChild(box);
  }

  // sim state: events in, immutable state out. While a replay is active the
  // screen shows replayView.state; the live state keeps updating underneath
  // (and the recorder keeps recording) so "Live" always returns to now.
  let state: OfficeState = INITIAL_STATE;
  let replayView: ReplayView | null = null;
  const current = () => replayView?.state ?? state;
  const recorder = new EventRecorder();
  const sfx = createSfx(); // R10: ambient office sound, opt-in (default off)

  // Latest wall-board snapshot (Scrum / Velocity); null fields → boards show
  // "daemon offline". Refreshed on a slow timer below, pushed into the office.
  let wallBoardData: WallBoardData = { scrum: null, velocityUsd: null };
  // PM chat (Round 5: one PM per repo): office key -> that office's PM session
  // id. The 3D office pins whichever one belongs to the active tab (see ticker).
  const pmPins = new Map<string, string>();

  // Live pipeline (packages/daemon) is the DEFAULT — real data is the soul.
  // ?mock=1 → mock scenario (dev/demo); ?ws=1 kept as an explicit alias.
  // ?stress=N → N extra background agents for the perf check.
  const params = new URLSearchParams(location.search);
  const stress = Number(params.get("stress") ?? "0") || 0;
  const useWs = params.get("mock") !== "1";

  // ?focus=<agentId> — deep link from a macOS notification click: once the
  // agent shows up in state (the daemon backlog fills it in right after
  // connect), jump to their repo tab, pan the camera and open the side
  // panel. Expires after 30s so a stale link can't yank the camera later.
  let pendingFocus = params.get("focus");
  const pendingFocusDeadline = Date.now() + 30_000;

  // Spike R5②: pending PermissionRequests answerable from the office. Lives
  // outside the sim reducer/protocol (UI-only state) — tapped straight off
  // the raw daemon frames so approving a tool call never touches agent
  // status logic. Mock mode has no daemon, so no approvals either.
  // The same raw tap feeds the Hiring Hall (roster_updated / chat_message) —
  // hiringHall is mounted further down, before source.start() fires.
  let hiringHall: HiringHallHandle | null = null;
  const approvals = useWs ? new ApprovalsStore() : undefined;
  const source: EventSource = useWs
    ? new WebSocketEventSource(undefined, undefined, (raw) => {
        approvals!.onRaw(raw);
        hiringHall?.onRaw(raw);
      })
    : new MockEventSource(buildScenario(stress));
  approvals?.backfill();

  source.subscribe((event) => {
    recorder.record(event);
    state = reduce(state, event);
    sfx.onEvent(event); // R10: ambient sound reacts to the live/mock event stream
  });

  // Mission Control panels (plain DOM, outside the canvas). In live mode the
  // side panel fetches the last transcript lines from the daemon's HTTP
  // endpoint (same host/port as the WS); mock mode leaves a placeholder.
  const fetchTranscript = useWs
    ? (sessionId: string, limit: number) =>
        fetch(
          `/transcript?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`,
        ).then((r) => r.json())
    : undefined;
  const fetchWorkItems = useWs
    ? (): Promise<WorkItemsFile> =>
        fetch("/work-items").then((r) => r.json())
    : undefined;
  // R13-B: kanban reads/writes work items through the daemon's project-scoped
  // /items contract (project slug "agent-office"). Live mode only, like the
  // other fetch helpers; mock leaves them undefined → mountKanban shows a placeholder.
  const fetchItems = useWs
    ? (project: string, source?: string): Promise<{ items: KanbanItem[] }> =>
        fetch(
          `/items?project=${encodeURIComponent(project)}${
            source ? `&source=${encodeURIComponent(source)}` : ""
          }`,
        ).then((r) => r.json())
    : undefined;
  const addItem = useWs
    ? (body: { project: string; title: string; source: string }): Promise<unknown> =>
        fetch("/items", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then((r) => r.json())
    : undefined;
  // R13-B-2: Nhật ký reads the daemon's merged /transcript (no sessionId —
  // last N events across every session). Live mode only, like fetchItems;
  // mock leaves it undefined → mountActivityLog shows a placeholder.
  const fetchRecentTranscript = useWs
    ? (limit = 100): Promise<TranscriptRow[]> =>
        fetch(`/transcript?limit=${limit}`).then((r) => r.json())
    : undefined;
  const sidePanel = mountSidePanel(
    document.querySelector<HTMLElement>("#side-panel")!,
    fetchTranscript,
    fetchWorkItems,
    // wi-pm-ux: PM characters get a "Tiếp tục trong Claude" row — the PM is a
    // real Claude Code session, resumable in a terminal via `claude --resume`.
    (a) => {
      for (const id of pmPins.values()) {
        if (id === a.sessionId) {
          return a.cwd ? `cd "${a.cwd}" && claude --resume ${a.sessionId}` : null;
        }
      }
      return null;
    },
  );
  mountBoard(document.querySelector<HTMLElement>("#board")!, fetchWorkItems);

  // R13-B: navbar rail + kanban view. The navbar emits a key; setView maps it
  // to body[data-view] (CSS shows/hides the matching panel).
  //
  // Always opens to the Văn phòng (office) — user decision 2026-07-22, overriding
  // the 2026-07-10 "open to Bảng việc" call. A refresh must always land on the
  // office, live or mock.
  const navbarItems: NavItem[] = [
    { key: "office", icon: "🏢", label: t("nav.office") },
    { key: "kanban", icon: "🗂", label: t("nav.board") },
    { key: "log", icon: "🕑", label: t("nav.log") },
    { key: "costs", icon: "💰", label: t("nav.costs") },
    { key: "settings", icon: "⚙", label: t("nav.settings") },
  ];
  const kanban = mountKanban(document.querySelector<HTMLElement>("#kanban")!, {
    project: "agent-office",
    ...(fetchItems ? { fetchItems } : {}),
    ...(addItem ? { addItem } : {}),
    // R13-B-3: "Giao cho PM" on an idea → pre-fill the PM chat (closure reads
    // chatHandle at click time; it's assigned later in boot when useWs mounts
    // the box, null in mock → no-op). Does NOT auto-send.
    onAssignToPM: (item) =>
      chatHandle?.prefill(t("kanban.askPm", { title: item.title })),
  });
  const activityLog = mountActivityLog(document.querySelector<HTMLElement>("#log")!, {
    ...(fetchRecentTranscript ? { fetchTranscript: fetchRecentTranscript } : {}),
  });
  const homeView = "office"; // refresh always lands on the office (2026-07-22)
  const navbar = mountNavbar(document.querySelector<HTMLElement>("#navbar")!, {
    items: navbarItems,
    active: homeView,
    onSelect: (key) => setView(key),
  });
  function setView(key: string): void {
    document.body.dataset.view = key;
    navbar.select(key);
    if (key === "kanban") kanban.refresh();
    if (key === "log") activityLog.refresh();
    if (key === "costs") costs.expand();
    if (key === "settings") settings.refresh();
  }

  // Cost dashboard (wi-cost-dashboard): "bảng lương" của công ty agent.
  const fetchCosts = useWs
    ? (w: CostWindow): Promise<CostsPayload> =>
        fetch(`/costs?window=${w}`).then((r) => r.json())
    : undefined;
  const costs = mountCosts(document.querySelector<HTMLElement>("#costs")!, fetchCosts, fetchWorkItems);

  // Cấu hình (R13-B): a real status screen — daemon connection + which agent CLIs
  // the app sees. Harness list is live-only; the WS reports connection changes.
  const settings = mountSettings(document.querySelector<HTMLElement>("#settings")!, {
    daemonUrl: "127.0.0.1:8787",
    ...(useWs
      ? {
          fetchHarnesses: (): Promise<HarnessStatus[]> =>
            fetch("/harnesses").then((r) => r.json()),
          probeHarness: (key: string): Promise<HarnessStatus[]> =>
            fetch(`/harnesses?probe=${encodeURIComponent(key)}`).then((r) => r.json()),
        }
      : {}),
  });
  if (source instanceof WebSocketEventSource) {
    source.onStatus = (c) => settings.setConnected(c);
  }

  // Open the home view only now: setView reaches for `costs` and `settings`,
  // declared just above. Called any earlier it works purely by luck — homeView
  // happens never to be "costs" or "settings", and the day it is, boot dies on a
  // TDZ ReferenceError with nothing on screen to explain why.
  setView(homeView);

  // Filing cabinet ("tủ hồ sơ", wi-office-life): click the sprite in the
  // office (a tagged prop the 3D raycast resolves) → daemon's GET /outputs / POST /open.
  const fetchOutputs = useWs
    ? (): Promise<{ files: OutputFile[] }> =>
        fetch("/outputs").then((r) => r.json())
    : undefined;
  const openPath = useWs
    ? (path: string, reveal?: boolean): Promise<void> =>
        fetch("/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, reveal }),
        })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
          })
          .catch((error: unknown) => {
            // outputs.ts's click handler fires-and-forgets openPath() with no
            // .catch of its own, so a daemon-side failure has to surface itself
            // here — reuse the outputs panel's own error style (same .empty
            // class it already uses for "Không kết nối được daemon.").
            document
              .querySelector("#outputs .outputs-panel h2")
              ?.insertAdjacentHTML(
                "afterend",
                `<p class="empty">${t("office.openFailed", { error: error instanceof Error ? error.message : String(error) })}</p>`,
              );
          })
    : undefined;
  const outputsPanel = mountOutputs(document.querySelector<HTMLElement>("#outputs")!, fetchOutputs, openPath);

  // Live wall boards (wi-office-makeover): refresh Scrum + Velocity every 45s
  // from the same daemon endpoints, push the snapshot to every open office.
  // Any fetch failing leaves that half null → the board shows "daemon offline"
  // rather than stale-forever numbers. Live mode only (mock has no daemon).
  if (fetchWorkItems && fetchCosts) {
    const refreshBoards = async (): Promise<void> => {
      const [scrum, velocityUsd] = await Promise.all([
        fetchWorkItems().then((f) => scrumSummary(f.items)).catch(() => null),
        fetchCosts("24h").then((c) => c.totalUsd).catch(() => null),
      ]);
      wallBoardData = { scrum, velocityUsd };
      office3d?.renderBoards(wallBoardData);
    };
    refreshBoards();
    setInterval(refreshBoards, 45_000);
  }

  // chatbox talks to the PM of the active tab — wired below (mounted later)
  let chatHandle: ChatBoxHandle | null = null;
  const tabs = mountOfficeTabs(document.querySelector<HTMLElement>("#office-tabs")!, (tab) => {
    const repo = tab.kind === "repo" ? tab.repo : null;
    chatHandle?.setRepo(repo);
    hiringHall?.setRepo(repo);
  });

  // Hiring Hall (wi-hiring-hall): click the reception desk → recruitment
  // panel (roster từ ~/.claude/company/roster.yaml qua daemon; form giao PM
  // tuyển qua POST /chat + skill company-hire). New roster members walk in
  // through the door of whatever office is on screen.
  const fetchRoster = useWs
    ? (): Promise<RosterPayload> => fetch("/roster").then((r) => r.json())
    : undefined;
  hiringHall = mountHiringHall(document.querySelector<HTMLElement>("#hiring-hall")!, {
    ...(fetchRoster ? { fetchRoster } : {}),
    walkIn: (name) => office3d?.walkInGreeter(name),
  });

  // "Công ty đóng hộp" (wi-templates-panel): xem template trong templates/ và
  // áp lên roster thật (daemon backup trước). Live mode only — apply cần daemon.
  const fetchTemplates = useWs
    ? (): Promise<TemplateSummary[]> => fetch("/templates").then((r) => r.json())
    : undefined;
  const applyTemplate = useWs
    ? async (name: string): Promise<ApplyResult> => {
        const res = await fetch("/templates/apply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const body = (await res.json()) as ApplyResult & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        return body;
      }
    : undefined;
  mountTemplates(document.querySelector<HTMLElement>("#templates")!, {
    ...(fetchTemplates ? { fetchTemplates } : {}),
    ...(applyTemplate ? { applyTemplate } : {}),
  });

  // Jump to an agent: switch to its repo's tab if needed, pan the camera to
  // the character, open the side panel. Shared by the intervention queue and
  // the org chart.
  const focusAgent = (agentId: string): void => {
    const agent = current().agents.get(agentId);
    if (agent && tabs.active.kind === "repo" && agent.repo !== tabs.active.repo) {
      tabs.select({ kind: "repo", repo: agent.repo });
    }
    office3d?.focusAgent(agentId);
    sidePanel.show(agentId);
  };

  // Intervention queue is deliberately GLOBAL (reads the full state): an
  // alert in repo B must be visible while you watch repo A. Clicking an item
  // jumps to that repo's tab (unless "All" already shows it) and pans there.
  const queue = mountInterventionQueue(
    document.querySelector<HTMLElement>("#queue-panel")!,
    focusAgent,
    approvals,
  );

  // THE ONE THING: ❗ out of the 3D window → OS notification (native toast on
  // the customer's Windows + taskbar badge). Same alert signal as the queue.
  const notifier = mountNotifier(focusAgent);

  // Org chart overlay ("Sơ đồ tổ chức", next to Board): who spawned whom,
  // per repo. Defaults to the active tab's repo; All groups by repo.
  mountOrgChart(
    document.querySelector<HTMLElement>("#orgchart")!,
    () => tabs.active,
    current,
    focusAgent,
  );

  // Building view ("Tòa nhà", R10-b): every repo as a floor — click one to
  // jump to its tab. Reads the same repoTabs selector the tab bar uses.
  mountBuildingView(
    document.querySelector<HTMLElement>("#building")!,
    current,
    () => Date.now(),
    (repo) => tabs.select({ kind: "repo", repo }),
  );

  // Replay / time-lapse timeline (bottom bar). At ≥4× characters teleport
  // between stations instead of walking and speech bubbles stay off.
  // Per-tab replay needs nothing extra: replay state flows through current()
  // and is filtered by the active tab exactly like live state.
  mountTimelineBar(document.querySelector<HTMLElement>("#timeline-bar")!, recorder, (view) => {
    replayView = view;
  }, () => office3d?.canvas ?? document.createElement("canvas")); // 🎬 records the office canvas

  // PM chatbox (live mode only): talk to the active tab's PM via the daemon's
  // POST /chat. Each repo's PM is pinned to the CEO desk of ITS office ("bàn
  // CEO" — art round 2 draws the real furniture); the default repo's PM also
  // takes the All office's desk. Streaming reply text is injected as
  // agent_message so the speech bubble shows the answer while the PM types.
  if (useWs) {
    const showChatBubble = (sessionId: string, text: string): void => {
      state = reduce(state, {
        v: 0,
        id: `chat-bubble:${sessionId}:${Date.now()}`,
        type: "agent_message",
        timestamp: Date.now(),
        sessionId,
        agentId: sessionId,
        parentId: null,
        text,
      });
    };
    // voice (R6): while TTS reads a reply aloud, re-inject the last line every
    // 3s so the PM's bubble stays lit past its 4s lifetime (no new sprite API)
    const lastReplyLine = new Map<string, string>();
    let bubbleKeepAlive: ReturnType<typeof setInterval> | null = null;
    chatHandle = mountChatBox({
      onPmSession: (repo, sessionId, isDefaultRepo) => {
        pmPins.set(repo, sessionId);
        if (isDefaultRepo) pmPins.set(ALL_KEY, sessionId);
        // the 3D office re-pins from pmPins every tick, so nothing to push here
      },
      onAssistantText: (sessionId, text) => {
        lastReplyLine.set(sessionId, text);
        showChatBubble(sessionId, text);
      },
      onPmSpeaking: (sessionId, speaking) => {
        if (bubbleKeepAlive) clearInterval(bubbleKeepAlive);
        bubbleKeepAlive = null;
        if (!speaking) return;
        bubbleKeepAlive = setInterval(() => {
          const text = lastReplyLine.get(sessionId);
          if (text) showChatBubble(sessionId, text);
        }, 3_000);
      },
    });
  }


  // 4 Hz is plenty for text panels and keeps DOM work off the render loop
  setInterval(() => {
    if (pendingFocus) {
      const agent = current().agents.get(pendingFocus);
      if (agent) {
        if (agent.repo) tabs.select({ kind: "repo", repo: agent.repo });
        office3d?.focusAgent(pendingFocus);
        sidePanel.show(pendingFocus);
        pendingFocus = null;
      } else if (Date.now() > pendingFocusDeadline) {
        pendingFocus = null;
      }
    }
    queue.render(current());
    notifier.sync(current());
    sidePanel.render(current(), replayView?.now);
    tabs.render(current());
  }, 250);

  // Render loop (rAF — the office owns its renderer now that Pixi is gone).
  let fps = 0, fpsFrames = 0, fpsSince = performance.now(), lastFrame = performance.now();
  // Quality watchdog — the rule itself lives in render3d/quality.ts so it can be
  // tested; rAF can't be driven from a test.
  let quality = initialQuality();
  function frame(now: number): void {
    const dtMs = Math.min(now - lastFrame, 100); // clamp: a backgrounded tab must not jump
    lastFrame = now;
    fpsFrames++;
    if (now - fpsSince >= 500) {
      fps = (fpsFrames * 1000) / (now - fpsSince);
      fpsFrames = 0;
      fpsSince = now;
      const verdict = watchQuality(quality, fps, now, !document.hidden);
      quality = verdict.state;
      if (verdict.degrade && office3d) {
        office3d.setQuality("low");
        console.warn(`[office] ${fps.toFixed(0)} fps — shadows off to keep it usable.`);
      }
    }

    const activeKey = keyOf(tabs.active);
    const s = activeKey === ALL_KEY ? current() : filterStateByRepo(current(), activeKey);
    // one 3D scene (not one per tab), so the CEO desk follows the active tab's PM
    office3d?.pinAgent(pmPins.get(activeKey) ?? null);
    office3d?.tick(s, dtMs, replayView ? { now: replayView.now, instant: replayView.speed >= 4 } : undefined);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // debug handle for dev-tools poking; not part of the public surface
  (window as unknown as Record<string, unknown>).__office3d = office3d;
  (window as unknown as Record<string, unknown>).__office = {
    getState: () => state,
    setState: (s: OfficeState) => {
      state = s;
    },
    tabs,
    source,
    recorder,
    hiringHall,
    getReplayView: () => replayView,
  };

  const controlsRoot = document.querySelector<HTMLElement>("#controls")!;
  if (source instanceof MockEventSource) {
    mountControls(
      controlsRoot,
      source,
      () => {
        state = INITIAL_STATE;
        tabs.select(TAB_ALL);
      },
      () => fps,
    );
  } else {
    // live status in a child span (not root.textContent) so the sfx toggle
    // appended below survives onStatus re-renders.
    const status = document.createElement("span");
    status.textContent = t("office.connecting", { url: wsBase() });
    controlsRoot.append(status);
    if (source instanceof WebSocketEventSource) {
      source.onStatus = (connected) => {
        status.textContent = connected
          ? `live: ${wsBase()}`
          : t("office.offline");
        status.style.color = connected ? "" : "#f87171";
      };
    }
  }
  // R10 ambient sound toggle — appended last so it survives both mountControls
  // (mock, which sets root.innerHTML) and the live status span above.
  const sfxBtn = document.createElement("button");
  const paintSfx = (): void => {
    sfxBtn.textContent = sfx.enabled() ? "🔊" : "🔇";
    sfxBtn.classList.toggle("sfx-on", sfx.enabled());
  };
  sfxBtn.title = t("office.soundTitle");
  sfxBtn.addEventListener("click", () => {
    sfx.setEnabled(!sfx.enabled());
    paintSfx();
    sfxBtn.blur();
  });
  paintSfx();
  controlsRoot.append(sfxBtn);

  if (office3d) {
    // R10-b: recenter the office — undoes a drag-pan or a focus-pan.
    const recenterBtn = document.createElement("button");
    recenterBtn.textContent = t("office.center");
    recenterBtn.title = t("office.centerTitle");
    recenterBtn.addEventListener("click", () => {
      office3d?.recenter();
      recenterBtn.blur();
    });
    controlsRoot.append(recenterBtn);

    // Lights-off (cinematic) — the monitors and neon carry the room on their own.
    let night = false;
    const nightBtn = document.createElement("button");
    const paintNight = (): void => {
      nightBtn.textContent = night ? t("office.lightsOn") : t("office.lightsOff");
      nightBtn.title = night ? t("office.lightsOnTitle") : t("office.lightsOffTitle");
      nightBtn.classList.toggle("sfx-on", night);
    };
    nightBtn.addEventListener("click", () => {
      night = !night;
      office3d?.setNight(night);
      paintNight();
      nightBtn.blur();
    });
    paintNight();
    controlsRoot.append(nightBtn);

    // Stand-up: pull everyone off their desks to the meeting table and back.
    let meeting = false;
    const meetBtn = document.createElement("button");
    const paintMeet = (): void => {
      meetBtn.textContent = meeting ? t("office.toDesks") : t("office.huddle");
      meetBtn.title = meeting ? t("office.toDesksTitle") : t("office.huddleTitle");
      meetBtn.classList.toggle("sfx-on", meeting);
    };
    meetBtn.addEventListener("click", () => {
      meeting = office3d?.toggleMeeting() ?? false;
      paintMeet();
      meetBtn.blur();
    });
    paintMeet();
    controlsRoot.append(meetBtn);
  }

  source.start();
}

boot();
