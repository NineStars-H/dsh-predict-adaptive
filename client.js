window.__ModuleLoader__.load({
  id: 'dsh-prompt-predict-adaptive',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Route served by the Host half. */
    const ROUTE = '/prompt-predict-adaptive';
    /** Bundle package name: the key the plugin page dispatches for config. */
    const PACKAGE = 'dsh-prompt-predict-adaptive';

    /*
     * How the suggestion is drawn.
     *
     * The composer owns one placeholder element (`[data-composer-placeholder]`)
     * that it shows while the draft is empty and hides as soon as the user types.
     * Instead of stacking a second absolutely-positioned line over it, this half
     * REWRITES that element's text and puts the original back when the
     * suggestion no longer applies.
     *
     * That single decision is what makes the interaction feel immediate:
     *
     *   - Accepting (Tab) fills the composer, so the draft is no longer empty and
     *     the host hides the placeholder itself. Nothing to synchronise.
     *   - Dismissing (Esc) is one synchronous DOM write. No request, no poll, no
     *     re-render, so it lands in the same frame as the key press.
     *   - Sending empties the draft; the host shows the placeholder again and the
     *     override is already cleared, so the official text is back immediately.
     *   - Clearing the composer by hand brings the same line back for free.
     *   - The text inherits the host's own colour, font and inset, because it is
     *     the host's own element.
     *
     * Nothing here guesses at layout, and there is no local timer anywhere: a
     * time window is what previously swallowed fresh drafts for seconds.
     */

    /** Two-language copy: the Client locale service is overkill for these strings. */
    const COPY = {
      zh: {
        toggleLabel: '输入框预测',
        toggleHint: '每轮对话结束后，用当前会话所选模型起草你的下一句话，替换输入框的占位提示。按 Tab 填入。',
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
        toggleHint: 'After each turn, the session model drafts your next message in place of the composer placeholder. Press Tab to fill it in.',
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
    };

    /** Selector for the composer's own placeholder element. */
    const PLACEHOLDER = '[data-composer-placeholder]';

    /**
     * Owns the composer placeholder's text for the whole session.
     *
     * The host re-renders that element whenever its own state changes, which
     * would silently drop our override, so this watches the element and puts the
     * override back. Writes are skipped when the text already matches, which is
     * what stops the observer from reacting to its own work.
     */
    function createPlaceholderController() {
      let node = null;
      let original = null;
      let desired = null;
      let observer = null;
      let observedParent = null;

      const lookup = () => {
        const found = document.querySelector(PLACEHOLDER);
        if (found !== node) {
          node = found;
          // A new element means the host rendered a new placeholder; its text is
          // the authoritative "official" text again.
          original = node === null ? null : node.textContent;
        }
        return node;
      };

      const write = () => {
        const target = lookup();
        if (target === null) return;
        const next = desired === null ? original : desired;
        if (next === null) return;
        if (target.textContent !== next) target.textContent = next;
      };

      const watch = () => {
        if (observer !== null || node === null) return;
        const parent = node.parentNode;
        if (parent === null || parent === observedParent) return;
        observer?.disconnect();
        observedParent = parent;
        observer = new MutationObserver(() => write());
        observer.observe(parent, { childList: true, characterData: true, subtree: true });
      };

      return {
        /** Place `text` over the official string, or restore it with `null`. */
        set(text) {
          desired = text;
          write();
          watch();
        },
        /** Give the element back to the host untouched. */
        release() {
          desired = null;
          write();
          observer?.disconnect();
          observer = null;
          observedParent = null;
          node = null;
          original = null;
        },
      };
    }

    /**
     * The prediction controller.
     *
     * Renders nothing: the visible suggestion IS the composer placeholder. This
     * component exists to own the polling, the key handling and the DOM write.
     */
    function PredictionController(props) {
      const { sessionId, inputActions, useInput } = props;
      const input = useInput((state) => state);
      const draft = typeof input?.draft === 'string' ? input.draft : '';
      const phase = input?.phase;
      const attachmentCount = Array.isArray(input?.attachmentIds) ? input.attachmentIds.length : 0;

      // The current suggestion and the recall ring, both curated by the Host.
      const [entry, setEntry] = React.useState(null);
      const [ring, setRing] = React.useState([]);

      const controller = React.useRef(null);
      if (controller.current === null) controller.current = createPlaceholderController();

      // Pull the Host's current answer without waiting for the next tick.
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
          try {
            const response = await fetch(
              `${ROUTE}/get?sessionId=${encodeURIComponent(String(sessionId))}`,
              { credentials: 'same-origin' },
            );
            if (response.ok) {
              const body = await response.json();
              if (!cancelled) {
                setEntry(body.suggestion ?? null);
                setRing(Array.isArray(body.history) ? body.history : []);
              }
            }
          } catch {
            /* the Host may be restarting; keep the last known state */
          }
          if (!cancelled) timer = window.setTimeout(tick, 700);
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

      React.useEffect(
        () => () => {
          controller.current?.release();
        },
        [],
      );

      const fallback = ring.length > 0 ? ring[0] : null;
      const suggestion = entry !== null && entry.text.length > 0 ? entry.text : fallback;
      const isFallback = entry === null && fallback !== null;

      // Whether the suggestion may replace the placeholder right now.
      //
      // The host hides the placeholder as soon as the draft is non-empty, so
      // these guards only have to cover the states where it would be wrong to
      // claim the space: text already typed, attachments in flight, or a command
      // being adjudicated.
      const show =
        suggestion !== null &&
        suggestion.length > 0 &&
        draft.length === 0 &&
        attachmentCount === 0 &&
        phase !== 'submitting' &&
        phase !== 'adjudicating';

      React.useEffect(() => {
        controller.current?.set(show ? suggestion : null);
      }, [show, suggestion]);

      /** Tell the Host how a draft was treated, so it can steer later ones. */
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
        if (!show || suggestion === null || !inputActions) return;
        let inserted = false;
        try {
          const span = inputActions.captureInsertion();
          inserted = inputActions.insertText(suggestion, span) !== false;
        } catch {
          /* the composer refused the insertion; leave the suggestion in place */
        }
        if (!inserted) return;
        // The composer now holds the text, so the placeholder is hidden by the
        // host itself; drop our override so a later clear cannot show stale text.
        controller.current?.set(null);
        setEntry(null);
        report('accepted');
        refresh();
      }, [show, suggestion, inputActions, report, refresh]);

      const dismiss = React.useCallback(() => {
        if (!show || suggestion === null) return;
        // Restore the official text first: this is synchronous, so Escape lands
        // in the same frame as the key press.
        controller.current?.set(null);
        setEntry(null);
        setRing((current) => current.filter((item) => item !== suggestion));
        // The Host cancels in-flight work too, so a prediction already running
        // cannot land a moment later and put the rejected line back.
        fetch(`${ROUTE}/dismiss`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: String(sessionId),
            text: suggestion,
            fromHistory: isFallback,
          }),
        })
          .then(() => refresh())
          .catch(() => {});
      }, [show, suggestion, sessionId, isFallback, refresh]);

      // Sending empties the composer. The host then shows the placeholder again,
      // and it must already hold the official text rather than the line the user
      // just rejected by sending something else.
      const previousDraft = React.useRef(draft);
      React.useEffect(() => {
        const before = previousDraft.current;
        previousDraft.current = draft;
        if (before.length === 0 || draft.length > 0) return;
        controller.current?.set(null);
        setEntry(null);
        setRing([]);
        if (sessionId) {
          fetch(`${ROUTE}/drop`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: String(sessionId) }),
          }).catch(() => {});
        }
      }, [draft, sessionId]);

      // Key handling is bound for the life of the component, not for the life of
      // one suggestion: a listener that unmounted with the ghost could not handle
      // the next Escape, which is why Escape used to appear intermittent.
      const latest = React.useRef({});
      latest.current = { show, accept, dismiss };
      React.useEffect(() => {
        const onKeyDown = (event) => {
          const state = latest.current;
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

      return null;
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
      // `saved` is what the Host holds; `draft` is what the form shows. Edits
      // land in `draft` only, so nothing takes effect until Save is pressed and
      // the user sees an explicit confirmation rather than guessing.
      const [saved, setSaved] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [status, setStatus] = React.useState('idle');
      const [error, setError] = React.useState(null);
      // Why the last prediction attempt produced nothing, when it did. Shown
      // here (not in the composer) so a rate limit is visible without touching
      // the placeholder.
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

      /** One labelled row with a control on the right. */
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
        row(
          t.toggleLabel,
          t.toggleHint,
          checkbox(draft.enabled !== false, (next) => patch({ enabled: next })),
        ),
        row(
          t.adaptiveLabel,
          t.adaptiveHint,
          checkbox(draft.adaptive !== false, (next) => patch({ adaptive: next })),
        ),
        row(
          t.workspaceLabel,
          t.workspaceHint,
          checkbox(draft.workspace !== false, (next) => patch({ workspace: next })),
        ),
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
        // The save bar is the explicit commitment step: it only enables when an
        // edit is pending, and it reports the outcome in place.
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
        // A failed prediction attempt is a diagnostic, not a composer feature.
        // Showing it here keeps the input area clean while still explaining why
        // nothing appeared.
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
            PredictionController,
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
