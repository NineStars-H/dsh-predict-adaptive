window.__ModuleLoader__.load({
  id: 'dsh-prompt-predict-adaptive',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Route served by the Host half. */
    const ROUTE = '/prompt-predict-adaptive';
    /** Bundle package name: the key the plugin page dispatches for config. */
    const PACKAGE = 'dsh-prompt-predict-adaptive';

    /** Two-language copy: the Client locale service is overkill for these strings. */
    const COPY = {
      zh: {
        toggleLabel: '输入框预测',
        toggleHint: '每轮对话结束后，用当前会话所选模型起草你的下一句话，显示在输入框上方。按 Tab 填入。',
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
        toggleHint: 'After each turn, the session model drafts your next message above the composer. Press Tab to fill it in.',
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
      heading: {
        fontSize: '13px',
        fontWeight: 600,
        margin: '0 0 8px',
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

    /**
     * The ghost suggestion.
     *
     * Two layout rules matter, and both came from watching it in the page:
     *
     * 1. **Hide the host's own placeholder while a suggestion shows.** The
     *    composer draws its `data-composer-placeholder` line itself; rendering a
     *    second line over it produced two overlapping strings. The host element
     *    is outside React's tree here, so it is toggled through a document-level
     *    style rule keyed on a body attribute.
     * 2. **Let it wrap.** A single `nowrap` line ellipsised any suggestion wider
     *    than the box, so the user never saw the end of the sentence.
     *
     * The anchor is the card's zero-height overlay seat, so this is positioned
     * over the editor's first text line: same inset as the host placeholder
     * (`4px 8px auto 14px` inside `.grow`) plus the card's own 8px top padding.
     */
    function PredictionOverlay(props) {
      const { sessionId, inputActions, useInput } = props;
      const input = useInput((state) => state);
      const [entry, setEntry] = React.useState(null);
      // Past drafts, newest first. Kept so a cleared composer can be recovered
      // without spending another model call.
      const [past, setPast] = React.useState([]);
      // When the composer was submitted, in epoch ms; 0 means nothing consumed.
      // Any suggestion produced at or before this instant belongs to the previous
      // composer and must not be shown again.
      const consumedAtRef = React.useRef(0);

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
                const next = body.suggestion ?? null;
                const consumedAt = consumedAtRef.current;
                const ring = Array.isArray(body.history) ? body.history : [];
                // A suggestion newer than the submission belongs to the next
                // turn and clears the consumed state.
                if (next !== null && (consumedAt === 0 || (next.at ?? 0) > consumedAt)) {
                  consumedAtRef.current = 0;
                  setEntry(next);
                  setPast(ring);
                } else if (consumedAt === 0) {
                  setEntry(null);
                  setPast(ring);
                } else {
                  // Consumed and still waiting for the next prediction: keep the
                  // composer clear even if the Host has not dropped its copy yet.
                  setEntry(null);
                  setPast([]);
                }
              }
            }
          } catch {
            /* the Host may be restarting; keep the last known state */
          }
          if (!cancelled) timer = window.setTimeout(tick, 2500);
        };
        tick();
        return () => {
          cancelled = true;
          window.clearTimeout(timer);
        };
      }, [sessionId]);

      const draft = typeof input?.draft === 'string' ? input.draft : '';
      const phase = input?.phase;
      const attachmentCount = Array.isArray(input?.attachmentIds) ? input.attachmentIds.length : 0;

      // Sending consumes whatever was pending, whether the user sent the
      // suggestion or typed their own message. Mark it consumed, hide it
      // locally, and tell the Host to drop its copy so a poll cannot bring it
      // back during the (possibly long) next turn.
      React.useEffect(() => {
        if (phase !== 'submitting') return;
        consumedAtRef.current = Date.now();
        setEntry(null);
        setPast([]);
        if (!sessionId) return;
        fetch(`${ROUTE}/drop`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: String(sessionId) }),
        }).catch(() => {});
      }, [phase, sessionId]);

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

      // What the ghost shows.
      //
      // A fresh suggestion always wins. When there is none — because the last
      // one was accepted (Tab fills the composer and the ghost clears) or
      // dismissed — fall back to the most recent draft in the ring. That makes
      // clearing the composer a no-op for the suggestion: the same line comes
      // back on its own, with no recall control to press.
      const fallback = past.length > 0 ? past[0] : null;
      const shownText = entry !== null && entry.text.length > 0 ? entry.text : fallback;
      const isFallback = entry === null && fallback !== null;

      const accept = React.useCallback(() => {
        if (shownText === null || shownText.length === 0 || !inputActions) return;
        let inserted = false;
        try {
          const span = inputActions.captureInsertion();
          inserted = inputActions.insertText(shownText, span) !== false;
        } catch {
          /* the composer refused the insertion; leave the ghost in place */
        }
        // Only a draft that actually reached the composer counts as accepted.
        if (inserted) report('accepted');
        setEntry(null);
      }, [shownText, inputActions, report]);

      const dismiss = React.useCallback(() => {
        setEntry(null);
        // Tell the Host which line was on screen and whether it came from the
        // auto-restore fallback. Without that distinction the Host would write a
        // rejected fallback back into the ring and the next poll would resurrect
        // it, making Escape look broken.
        if (sessionId && shownText !== null && shownText.length > 0) {
          fetch(`${ROUTE}/dismiss`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: String(sessionId),
              text: shownText,
              fromHistory: isFallback,
            }),
          }).catch(() => {});
        } else {
          report('dismiss');
        }
        // Drop it locally too so the 2.5s poll cannot re-show it from stale
        // state before the Host's answer lands.
        if (isFallback && fallback !== null) {
          setPast((current) => current.filter((item) => item !== fallback));
        }
      }, [report, sessionId, shownText, isFallback, fallback]);

      const showText =
        shownText !== null &&
        shownText.length > 0 &&
        draft.length === 0 &&
        // The ghost is absolutely positioned over the editor's first line, so it
        // would paint across attachment thumbnails. Annotated messages are a
        // different interaction; stay out of their way entirely.
        attachmentCount === 0 &&
        phase !== 'submitting' &&
        phase !== 'adjudicating';

      // Suppress the native placeholder while a suggestion is on screen.
      //
      // A stylesheet rule proved unreliable: the host injects its composer CSS
      // dynamically, so cascade order is not ours to control and the placeholder
      // kept painting underneath the ghost. Setting the property inline on the
      // element itself cannot lose that race, so this writes the style directly
      // and restores whatever was there before.
      React.useEffect(() => {
        if (!showText) return undefined;
        const targets = Array.from(document.querySelectorAll('[data-composer-placeholder]'));
        const saved = targets.map((node) => node.style.visibility);
        for (const node of targets) node.style.visibility = 'hidden';
        return () => {
          targets.forEach((node, index) => {
            node.style.visibility = saved[index] ?? '';
          });
        };
      }, [showText]);

      React.useEffect(() => {
        if (!showText) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            event.stopPropagation();
            accept();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, [showText, accept, dismiss]);

      // Nothing to offer: render nothing. A failed attempt (rate limit, quota)
      // has no place in the composer — the user cannot act on it there, and the
      // notice overlapped the host's placeholder. The reason is still surfaced
      // in the plugin's settings page, where it is expected.
      if (!showText) return null;

      return h(
        'div',
        {
          'data-prompt-predict-ghost': true,
          style: {
            position: 'absolute',
            // 8px card padding-top + 4px editor padding-top.
            top: '12px',
            // The editor's own left padding, so the ghost starts on the same
            // column as typed text.
            left: '14px',
            right: '8px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '6px',
            font: 'inherit',
            fontSize: 'inherit',
            lineHeight: 'inherit',
            fontWeight: 'inherit',
            // Upright: italics read as another message, not a suggestion.
            fontStyle: 'normal',
            color: 'var(--dsw-alias-label-caption)',
            pointerEvents: 'none',
            userSelect: 'none',
            // Wrap instead of clipping: an ellipsised suggestion hides the part
            // that makes it actionable, so short hints never showed their verb.
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
          },
        },
        h(
          'span',
          { style: { minWidth: 0, flex: '1 1 auto' } },
          shownText,
        ),
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
      // `saved` is what the Host holds; `draft` is what the form shows. Edits
      // land in `draft` only, so nothing takes effect until Save is pressed and
      // the user sees an explicit confirmation rather than guessing.
      const [saved, setSaved] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [status, setStatus] = React.useState('idle');
      const [error, setError] = React.useState(null);
      // Why the last prediction attempt produced nothing, when it did. Shown
      // here (not in the composer) so a rate limit is visible without painting
      // over the placeholder.
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
