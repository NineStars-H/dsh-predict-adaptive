window.__ModuleLoader__.load({
  id: 'dsh-prompt-predict-adaptive',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Route served by the Host half. */
    const ROUTE = '/prompt-predict-adaptive';
    /** Bundle package name: the key the plugin page dispatches for config. */
    const PACKAGE = 'dsh-prompt-predict-adaptive';
    /** The composer's own placeholder element, hidden while a suggestion shows. */
    const PLACEHOLDER = '[data-composer-placeholder]';

    /*
     * Why this looks the way it does.
     *
     * The suggestion is drawn by this component. An earlier revision rewrote the
     * host's placeholder element instead, and it flickered: React owns that text
     * node (`children: placeholderText`), so every host render put the official
     * string back and the two fought over one element. Drawing our own node ends
     * that conflict.
     *
     * What made the old build feel slow was never the drawing, it was that every
     * transition waited for a round trip: Escape had to tell the Host and wait
     * for the reply to stop painting; sending waited for the Host to notice the
     * submission; clearing waited for a poll to bring the line back.
     *
     * So the state is split. This half owns what is on SCREEN and answers the
     * user immediately; the Host owns what the model produced. Three local guards
     * make that safe, and all three are synchronous:
     *
     *   `dismissed`  texts the user rejected, never painted again however stale
     *                or late a reply is. This replaces any time window.
     *   `consumedAt` instant of the last send; a suggestion stamped at or before
     *                it belongs to the conversation the user already left.
     *   `ring`       the Host's recall list, kept locally so a manual clear
     *                repaints in the same frame instead of after a poll.
     */

    /** Two-language copy: the Client locale service is overkill for these strings. */
    const COPY = {
      zh: {
        toggleLabel: '输入框预测',
        toggleHint: '每轮对话结束后，用当前会话所选模型起草你的下一句话，显示在输入框上方。按 Tab 填入，按 Esc 丢弃。',
        contextLabel: '预测上下文',
        contextHint: '完整会重放整段对话；最近轮次只保留末尾几轮。',
        contextFull: '完整上下文',
        contextRecent: '最近轮次',
        turnsLabel: '保留轮数',
        reset: '重置',
        unavailable: '不可用',
        loading: '加载中…',
        adaptiveLabel: '自适应',
        adaptiveHint: '从你采纳或丢弃的草稿里学习措辞。关闭后行为与基础版完全一致。',
        workspaceLabel: '并入工作区状态',
        workspaceHint: '把本会话改过的文件清单加入预测上下文，让建议能点名具体文件。',
        permissionsLabel: '继承会话权限',
        permissionsHint: '告知预测当前沙箱与审批状态，避免建议出无权执行的动作。',
        learnedLabel: '学习状态',
        learnedHint: '已采纳 / 已丢弃的草稿会用于调整后续预测。',
        save: '保存',
        saving: '保存中…',
        saved: '已保存设置',
        unsaved: '有未保存的修改',
        predictionError: '预测失败',
      },
      en: {
        toggleLabel: 'Composer predictions',
        toggleHint: 'After each turn, the session model drafts your next message above the composer. Tab fills it in, Esc drops it.',
        contextLabel: 'Prediction context',
        contextHint: 'Full replays the whole conversation; recent keeps only the trailing turns.',
        contextFull: 'Full context',
        contextRecent: 'Recent turns',
        turnsLabel: 'Turns to keep',
        reset: 'Reset',
        unavailable: 'Unavailable',
        loading: 'Loading…',
        adaptiveLabel: 'Adaptive',
        adaptiveHint: 'Learn phrasing from the drafts you accept or dismiss. Off behaves exactly like the plain build.',
        workspaceLabel: 'Include workspace state',
        workspaceHint: 'Add this session\u2019s changed files to the prediction, so a draft can name exact paths.',
        permissionsLabel: 'Inherit session permissions',
        permissionsHint: 'Tell the prediction the sandbox and approval posture, so it avoids impossible actions.',
        learnedLabel: 'Learned steering',
        learnedHint: 'Accepted / dismissed drafts steer later predictions.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Settings saved',
        unsaved: 'Unsaved changes',
        predictionError: 'Prediction failed',
      },
    };

    /** Pick the copy that matches the page language. */
    function copy() {
      const lang = (typeof document !== 'undefined' && document.documentElement.lang) || 'en';
      return String(lang).toLowerCase().startsWith('zh') ? COPY.zh : COPY.en;
    }

    const styles = {
      section: {
        font: 'inherit',
        color: 'var(--dsw-alias-label-primary, inherit)',
        padding: '4px 0 12px',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '9px 0',
        fontSize: '13px',
      },
      hint: { fontSize: '11px', opacity: 0.6, marginTop: '2px', lineHeight: '1.45' },
      control: {
        font: 'inherit',
        fontSize: '13px',
        padding: '3px 6px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, #3a3f46)',
        background: 'var(--dsw-specific-input-major, transparent)',
        color: 'inherit',
        flex: '0 0 auto',
      },
      ghost: {
        position: 'absolute',
        /*
         * Exactly the host placeholder's own box.
         *
         * `.placeholder` is `inset: 4px 8px auto 14px` inside the editor's growing
         * box, so the suggestion occupies the same rectangle the official text
         * would. The anchor this renders into is the composer card, whose top
         * padding is 8px, so the vertical inset is offset by that to land on the
         * same row rather than 8px lower.
         */
        top: '12px', // card padding-top (8px) + placeholder top (4px)
        left: '14px',
        right: '8px',
        font: 'inherit',
        fontSize: 'inherit',
        fontWeight: 'inherit',
        fontStyle: 'normal',
        color: 'var(--dsw-alias-label-caption)',
        pointerEvents: 'none',
        userSelect: 'none',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        /*
         * Two lines must end above the toolbar.
         *
         * The budget, measured from the card's top edge:
         *
         *   8px card padding-top + 4px placeholder inset   = 12px  (this `top`)
         *   36px editor min-height -> editor ends at         44px
         *   12px card gap -> the toolbar starts at           56px
         *
         * So there are 44px for the text. Inheriting the composer's line box gives
         * 24px per line, and two of those reach 60px — 4px over, which is exactly
         * the half-covered second line that showed up. Tightening the line box to
         * 22px puts two lines at 44px, flush against the toolbar and not past it.
         * 22px still clears the 14px font, so the text is not cramped.
         */
        lineHeight: '22px',
        // Room for the descenders of the second line inside that budget.
        paddingBottom: '0px',
        // The container is a row: the text, then the Tab badge beside it. The line
        // clamp below lives on the text itself, so this stays a flex row.
        display: 'flex',
        alignItems: 'flex-start',
        gap: '6px',
      },
      /*
       * Clamp the suggestion to two lines, ellipsis on the third.
       *
       * Two lines is what fits the space the empty composer already occupies: the
       * anchor this sits in is `height: 0; position: absolute`, so the ghost takes
       * no part in layout and cannot grow the card — anything past the second line
       * would cover the toolbar underneath rather than extending the box.
       *
       * The full text is one keypress away: Tab puts all of it into the composer.
       */
      ghostText: {
        minWidth: 0,
        flex: '1 1 auto',
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: '2',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
    };

    /**
     * The suggestion overlay.
     *
     * Renders its own line and hides the host placeholder with `visibility`
     * while it shows. React sets no style on that node, so this never competes
     * with a host render the way rewriting its text did.
     */
    function PredictionOverlay(props) {
      const { sessionId, inputActions, useInput, useSession } = props;
      const input = useInput((state) => state);
      const draft = typeof input?.draft === 'string' ? input.draft : '';
      const phase = input?.phase;
      const attachmentCount = Array.isArray(input?.attachmentIds) ? input.attachmentIds.length : 0;

      // A submission in flight.
      //
      // `pendingSubmissions` is the one signal that appears on the click's own
      // frame: the session writes a local echo there before the prompt is even
      // serialised, and retires it once the transcript takes over. That is exactly
      // the window in which the ghost must not be painted, and it starts
      // immediately — unlike `phase`, which never leaves `plain` for an ordinary
      // send, and unlike the session log, which lags by a poll.
      const pending = useSession === undefined
        ? 0
        : useSession((state) => {
            const list = state?.pendingSubmissions;
            return Array.isArray(list) ? list.length : 0;
          });

      // What the Host last reported, and the recall list kept for instant recall.
      const [entry, setEntry] = React.useState(null);
      const [ring, setRing] = React.useState([]);

      // The Host's own rejection list and last-submission instant. These are the
      // durable copies: the page unmounts this component whenever it switches
      // conversation, so anything remembered only here would be forgotten and
      // the rejected line would come back on the next visit.
      const [rejected, setRejected] = React.useState(() => new Set());
      const [consumedAt, setConsumedAt] = React.useState(0);

      // The same two facts learnt locally in the moment, so the very next frame
      // is correct without waiting for a round trip. The Host's copies take over
      // as soon as they arrive, and a remount starts from them.
      // Texts rejected by Escape in this mount. The Host keeps the durable copy;
      // this only makes the very next frame correct.
      const [localDismissed, setLocalDismissed] = React.useState(() => new Set());

      // Bumped on every local invalidation so an in-flight reply discards itself
      // instead of painting over the decision the user just made.
      const epochRef = React.useRef(0);
      // The text this half just inserted with Tab, so the transition that follows
      // can be recognised as "an accept, then the field emptied" rather than a
      // send. It is a hint for the Host, which decides from the session log.
      const acceptPendingRef = React.useRef(null);
      // Set once a submission has been observed, and cleared only when the composer
      // is provably a new one. The submission echo is transient, so remembering it
      // in state is what stops the ghost blinking back between the send and the
      // next Host reply: a ref would change the flag without a repaint.
      const [sent, setSent] = React.useState(false);

      const refreshRef = React.useRef(null);
      const refresh = React.useCallback(() => {
        const run = refreshRef.current;
        if (typeof run === 'function') run();
      }, []);

      React.useEffect(() => {
        if (!sessionId) return undefined;
        let cancelled = false;
        let timer = 0;
        const tick = async () => {
          const epoch = epochRef.current;
          try {
            const response = await fetch(
              `${ROUTE}/get?sessionId=${encodeURIComponent(String(sessionId))}`,
              { credentials: 'same-origin' },
            );
            if (response.ok) {
              const body = await response.json();
              // A local decision made while this request was in flight wins: the
              // reply describes a state the user has already left.
              if (!cancelled && epoch === epochRef.current) {
                setEntry(body.suggestion ?? null);
                setRing(Array.isArray(body.history) ? body.history : []);
                // The rejection list and the last-submission instant come from
                // the Host too. Keeping them there is what makes them survive a
                // page switching conversation, which unmounts this component.
                setRejected(new Set(Array.isArray(body.dismissed) ? body.dismissed : []));
                setConsumedAt(typeof body.consumedAt === 'number' ? body.consumedAt : 0);
              }
            }
          } catch {
            /* the Host may be restarting; keep the last known state */
          }
          if (!cancelled) timer = window.setTimeout(tick, 900);
        };
        refreshRef.current = () => {
          if (timer !== 0) window.clearTimeout(timer);
          timer = 0;
          void tick();
        };
        tick();
        return () => {
          cancelled = true;
          refreshRef.current = null;
          window.clearTimeout(timer);
        };
      }, [sessionId]);

      // What to show. Every guard is a lookup or a comparison, so this resolves
      // synchronously and nothing here can delay a repaint. The rejection set and
      // the submission instant are mirrored from the Host, so a remount cannot
      // forget them.
      const candidate = React.useMemo(() => {
        const usable = (text, at) => {
          if (typeof text !== 'string' || text.length === 0) return null;
          if (rejected.has(text)) return null;
          if (localDismissed.has(text)) return null;
          if (at !== undefined && at !== null && at <= consumedAt) return null;
          return text;
        };
        const fresh = entry === null ? null : usable(entry.text, entry.at);
        if (fresh !== null) return fresh;
        for (const text of ring) {
          const recalled = usable(text, undefined);
          if (recalled !== null) return recalled;
        }
        return null;
      }, [entry, ring, rejected, consumedAt, localDismissed]);

      const show =
        candidate !== null &&
        draft.length === 0 &&
        attachmentCount === 0 &&
        // A submission in flight means the composer is no longer waiting for a
        // suggestion: hide on the same frame the user pressed send, instead of
        // waiting for the Host to answer and retire the draft.
        pending === 0 &&
        // And stay hidden after the echo retires, until the composer is new.
        !sent &&
        phase !== 'submitting' &&
        phase !== 'adjudicating';

      // Hide the host's own placeholder while the ghost is on screen. `visibility`
      // is ours to write: React sets no style on that element.
      React.useEffect(() => {
        if (!show) return undefined;
        const nodes = Array.from(document.querySelectorAll(PLACEHOLDER));
        const saved = nodes.map((node) => node.style.visibility);
        for (const node of nodes) node.style.visibility = 'hidden';
        return () => {
          nodes.forEach((node, index) => {
            node.style.visibility = saved[index] ?? '';
          });
        };
      }, [show]);

      const report = React.useCallback(
        (action) => {
          if (!sessionId) return;
          fetch(`${ROUTE}/${action}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: String(sessionId) }),
          }).catch(() => {});
        },
        [sessionId],
      );

      const accept = React.useCallback(() => {
        if (!show || candidate === null || !inputActions) return;
        let inserted = false;
        try {
          const span = inputActions.captureInsertion();
          inserted = inputActions.insertText(candidate, span) !== false;
        } catch {
          /* the composer refused the insertion; leave the ghost alone */
        }
        if (!inserted) return;
        // The text now lives in the composer, so it must not be painted under the
        // cursor. That is not the same as rejecting it: the ring keeps the line so
        // clearing the field brings it back. Recording what was inserted lets the
        // next empty-composer transition be read as an accept rather than a send.
        acceptPendingRef.current = candidate;
        epochRef.current += 1;
        setEntry(null);
        setRing((current) => current.filter((item) => item !== candidate));
        report('accepted');
        refresh();
      }, [show, candidate, inputActions, report, refresh]);

      const dismiss = React.useCallback(() => {
        if (!show || candidate === null) return;
        // Synchronous and final. The local set covers the next frame, and the
        // Host records it durably so a page switching conversation cannot forget
        // it — that remount is exactly what used to bring a rejected line back.
        setLocalDismissed((current) => new Set(current).add(candidate));
        epochRef.current += 1;
        setEntry(null);
        setRing((current) => current.filter((item) => item !== candidate));
        if (!sessionId) return;
        fetch(`${ROUTE}/dismiss`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: String(sessionId), text: candidate }),
        })
          .then(() => refresh())
          .catch(() => {});
      }, [show, candidate, sessionId, refresh]);

      // A submission was observed. Latch it until the Host's answer proves the
      // composer is a new one, because the echo that reveals a send is transient:
      // it retires as soon as the transcript adopts the message, which is before
      // the next poll. Watching only the echo made the ghost blink — hidden while
      // it was live, repainted when it retired, then gone again on the poll.
      //
      // The latch is cleared only by evidence of a NEW composer: a Host reply that
      // reports a fresh suggestion, or the user typing again.
      React.useEffect(() => {
        if (pending === 0) return;
        setSent(true);
        setEntry(null);
        setRing([]);
      }, [pending]);

      // The composer went from non-empty to empty. Three events look identical
      // from here — a send, a Tab-then-clear, and typing something and deleting
      // it — and the Client has no way to tell them apart: `InputState.phase`
      // stays `plain` for every ordinary send, and the composer clears before the
      // Host has appended the `user/message` that proves a send happened.
      //
      // So it guesses nothing and decides nothing. It reports "the composer is
      // empty" and lets the Host settle which case it was from the session log.
      // Until that answer arrives the ghost is hidden, which is the safe
      // direction: a wrong guess here can only lose a line for one poll, never
      // paint a stale one over an empty box.
      const previousDraft = React.useRef(draft);
      React.useEffect(() => {
        const before = previousDraft.current;
        previousDraft.current = draft;
        // Typing again means a new composer, so a previous send no longer applies.
        if (draft.length > 0 && sent) setSent(false);
        if (before.length === 0 || draft.length > 0) return;
        acceptPendingRef.current = null;
        setEntry(null);
        if (!sessionId) return;
        fetch(`${ROUTE}/drop`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: String(sessionId) }),
        })
          .then(() => refresh())
          .catch(() => {});
      }, [draft, sent, sessionId, refresh]);

      // Key handling lives for the whole component. A listener tied to "a
      // suggestion is on screen" unmounted with the ghost, so the next Escape
      // fell through to the host and Escape looked unreliable.
      const live = React.useRef({});
      live.current = { show, accept, dismiss };
      React.useEffect(() => {
        const onKeyDown = (event) => {
          const state = live.current;
          if (!state.show) return;
          if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            event.stopPropagation();
            state.accept();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            state.dismiss();
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, []);

      if (!show) return null;

      return h(
        'div',
        { 'data-prompt-predict-ghost': true, style: styles.ghost },
        h('span', { style: styles.ghostText }, candidate),
        h(
          'span',
          {
            style: {
              flex: '0 0 auto',
              alignSelf: 'flex-start',
              marginTop: '1px',
              padding: '0 4px',
              borderRadius: '3px',
              border: '1px solid var(--dsw-alias-border-l2)',
              fontSize: '10px',
              lineHeight: '16px',
              opacity: 0.75,
            },
          },
          'Tab',
        ),
      );
    }

    /**
     * This bundle's own configuration block.
     *
     * Mounted in `plugins.bundle.config` keyed by the PACKAGE name: the plugin
     * page dispatches that key between the bundle description and its component
     * rows, which is exactly where a bundle's settings belong.
     */
    function PredictionConfig(props) {
      const { view } = props;
      const t = copy();
      const [saved, setSaved] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [status, setStatus] = React.useState('idle');
      const [error, setError] = React.useState(null);
      const [lastError, setLastError] = React.useState(null);

      React.useEffect(() => {
        let cancelled = false;
        fetch(`${ROUTE}/get?sessionId=`, { credentials: 'same-origin' })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })
          .then((body) => {
            if (cancelled) return;
            if (body && body.config) {
              setSaved(body.config);
              setDraft(body.config);
            } else setError('no config in response');
            if (typeof body.error === 'string' && body.error.length > 0) setLastError(body.error);
          })
          .catch((reason) => {
            if (!cancelled) setError(String(reason && reason.message ? reason.message : reason));
          });
        return () => {
          cancelled = true;
        };
      }, []);

      const FIELDS = ['enabled', 'adaptive', 'workspace', 'permissions', 'mode', 'recentTurns'];
      const dirty =
        saved !== null && draft !== null && FIELDS.some((key) => saved[key] !== draft[key]);
      const busy = status === 'saving';

      const commit = React.useCallback(async () => {
        if (draft === null) return;
        setStatus('saving');
        try {
          const response = await fetch(`${ROUTE}/config`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              enabled: draft.enabled,
              adaptive: draft.adaptive,
              workspace: draft.workspace,
              permissions: draft.permissions,
              mode: draft.mode,
              recentTurns: draft.recentTurns,
            }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          setSaved(body.config ?? null);
          setDraft(body.config ?? null);
          setError(null);
          setStatus('saved');
          window.setTimeout(() => setStatus((current) => (current === 'saved' ? 'idle' : current)), 2200);
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason));
          setStatus('idle');
        }
      }, [draft]);

      const patch = (changes) => setDraft((current) => ({ ...current, ...changes }));

      if (view === 'summary') {
        if (saved === null) return t.loading;
        if (saved.enabled === false) return '—';
        return saved.mode === 'recent' ? `recent ×${saved.recentTurns}` : 'full';
      }

      if (draft === null) {
        return h(
          'div',
          { style: { ...styles.section, opacity: 0.7 } },
          h('div', null, t.toggleLabel),
          h('div', { style: styles.hint }, error === null ? t.loading : `${t.unavailable}: ${error}`),
        );
      }

      const row = (label, hint, control) =>
        h(
          'div',
          { style: styles.row },
          h(
            'div',
            { style: { minWidth: 0 } },
            h('div', null, label),
            hint === null ? null : h('div', { style: styles.hint }, hint),
          ),
          control,
        );

      const checkbox = (checked, onChange, disabled) =>
        h('input', {
          type: 'checkbox',
          checked,
          disabled: disabled || busy,
          onChange: (event) => onChange(event.target.checked),
          style: styles.control,
        });

      return h(
        'div',
        { style: styles.section },
        row(t.toggleLabel, t.toggleHint, checkbox(draft.enabled !== false, (next) => patch({ enabled: next }))),
        row(t.adaptiveLabel, t.adaptiveHint, checkbox(draft.adaptive !== false, (next) => patch({ adaptive: next }))),
        row(t.workspaceLabel, t.workspaceHint, checkbox(draft.workspace !== false, (next) => patch({ workspace: next }))),
        row(
          t.permissionsLabel,
          t.permissionsHint,
          checkbox(draft.permissions !== false, (next) => patch({ permissions: next })),
        ),
        row(
          t.contextLabel,
          t.contextHint,
          h(
            'select',
            {
              value: draft.mode === 'recent' ? 'recent' : 'full',
              disabled: busy,
              style: styles.control,
              onChange: (event) => patch({ mode: event.target.value }),
            },
            h('option', { value: 'full' }, t.contextFull),
            h('option', { value: 'recent' }, t.contextRecent),
          ),
        ),
        draft.mode === 'recent'
          ? row(
              t.turnsLabel,
              null,
              h('input', {
                type: 'number',
                min: 1,
                max: 40,
                value: draft.recentTurns ?? 6,
                disabled: busy,
                style: { ...styles.control, width: '72px' },
                onChange: (event) => {
                  const next = Number(event.target.value);
                  if (Number.isInteger(next) && next >= 1 && next <= 40) patch({ recentTurns: next });
                },
              }),
            )
          : null,
        row(
          t.learnedLabel,
          t.learnedHint,
          h(
            'button',
            {
              type: 'button',
              disabled: busy || draft.adaptive === false,
              onClick: async () => {
                setStatus('saving');
                try {
                  await fetch(`${ROUTE}/reset`, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ sessionId: '' }),
                  });
                } catch {
                  /* the counter keeps its current value */
                }
                setStatus('saved');
                window.setTimeout(() => setStatus((current) => (current === 'saved' ? 'idle' : current)), 2200);
              },
              style: { ...styles.control, cursor: 'pointer' },
            },
            t.reset,
          ),
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: '10px',
              paddingTop: '10px',
              marginTop: '4px',
              borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))',
            },
          },
          error !== null
            ? h(
                'span',
                {
                  style: {
                    marginRight: 'auto',
                    fontSize: '11px',
                    color: 'var(--dsw-alias-state-warn-primary, #d97706)',
                  },
                },
                `${t.unavailable}: ${error}`,
              )
            : h(
                'span',
                {
                  style: {
                    marginRight: 'auto',
                    fontSize: '11px',
                    opacity: 0.7,
                    color:
                      status === 'saved'
                        ? 'var(--dsw-alias-state-success-primary, #16a34a)'
                        : undefined,
                  },
                },
                status === 'saved' ? t.saved : dirty ? t.unsaved : '',
              ),
          h(
            'button',
            {
              type: 'button',
              disabled: !dirty || busy,
              onClick: commit,
              style: {
                ...styles.control,
                cursor: dirty && !busy ? 'pointer' : 'default',
                opacity: dirty && !busy ? 1 : 0.5,
                padding: '5px 14px',
                fontWeight: 500,
              },
            },
            busy ? t.saving : t.save,
          ),
        ),
        lastError !== null
          ? h(
              'div',
              {
                style: {
                  ...styles.hint,
                  color: 'var(--dsw-alias-state-warn-primary, #d97706)',
                  paddingTop: '6px',
                },
              },
              `${t.predictionError}: ${lastError}`,
            )
          : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.overlay', () =>
          ctx.slots.register(
            { name: 'conversation.input.overlay', id: 'prompt-predict-adaptive', order: 40 },
            PredictionOverlay,
          ),
        );
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: PACKAGE },
            PredictionConfig,
          ),
        );
      },
    };
  },
});

