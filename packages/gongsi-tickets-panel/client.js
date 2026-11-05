/**
 * Client half of the gongsi ticket panel bundle.
 *
 * Contributes two things to the Harness Web UI:
 *
 *   - a panel icon in the **left sidebar** (`sidebar.panellist`), and
 *   - the panel body (`main`, keyed `gongsi-tickets`), organized as four tabs:
 *     every ticket the account can see, the tickets it owns, a form that files
 *     a new ticket (with screenshots pasted straight into the description),
 *     and the endpoint / API key / row-count configuration. A filter bar
 *     narrows the list by keyword, status, issue type, priority, school, and
 *     creator. Clicking a ticket drills into its read-only detail (description,
 *     conclusion, worklogs, attachments, activity log).
 *
 * Every ticket row carries the writes the gongsi list itself offers:
 * 分派 (assign the owner), 记工时 (book hours on the underlying task) and
 * 评论 (append a processing comment). A comment takes a pasted screenshot, and
 * the image is attached to the ticket right after the note is written. A
 * ticket assigned to me additionally offers 开始处理 while it waits and
 * 确认完成 while it is being worked on; on somebody else's ticket those two
 * are not shown.
 *
 * The ticket data comes from the Host half over the already-mounted `commands`
 * Remote namespace, so the API key never reaches the browser.
 *
 * Configuration is read through `ctx.configForms`. The form namespace is the
 * Loader entry id, which the profile patch turns into `include:<row id>`, so the
 * namespace is discovered from the served-directory snapshot instead of assumed.
 */
window.__ModuleLoader__.load({
  id: '@local/gongsi-tickets-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Locale namespace of this plugin. */
    const NS = 'gongsi-tickets-panel'

    /** The main-panel key this plugin owns. */
    const PANEL_ID = 'gongsi-tickets'

    /** The config row id, as the bundle patch declares it. */
    const CONFIG_ROW = 'gongsi-tickets-panel'

    /** The Loader entry id the profile composes for that row. */
    const CONFIG_NS = `include:${CONFIG_ROW}`

    /** The slash command the Host half exposes for the ticket list. */
    const TICKETS_COMMAND = '/gongsi-tickets'

    /**
     * The console a share link points at, when the endpoint does not say.
     *
     * The endpoint names the API path; the console is the site above it.
     */
    const DEFAULT_CONSOLE = 'https://yanfa.scedu.tech'

    /**
     * The skill a quote names, registered by the Host half.
     *
     * It carries the instructions for working on one ticket, so the composer
     * shows a module instead of a wall of pasted text.
     */
    const QUOTE_SKILL = '/gongsi-ticket'

    /** Status colours come from the host theme; only artwork keeps literal colours. */
    const STATUS_COLORS = {
      created: 'var(--dsw-alias-state-idle-primary)',
      assigned: 'var(--dsw-alias-brand-primary)',
      processing: 'var(--dsw-alias-state-warn-primary)',
      pending_review: 'var(--dsw-alias-state-warn-primary)',
      completed: 'var(--dsw-alias-state-success-primary)',
      closed: 'var(--dsw-alias-state-success-primary)',
      cancelled: 'var(--dsw-alias-label-secondary)',
    }

    /** Human labels for the gongsi ticket statuses. */
    const STATUS_LABELS = {
      created: '新建',
      assigned: '待处理',
      processing: '处理中',
      pending_review: '待确认',
      completed: '已完成',
      closed: '已关闭',
      cancelled: '已取消',
    }

    /** Priority labels. */
    const PRIORITY_LABELS = {
      high: '高',
      medium: '中',
      normal: '普通',
      low: '低',
    }

    /**
     * The statuses the filter bar offers, in the order the board shows them.
     *
     * `closed` is not a server-side status; the server knows created, assigned,
     * processing, pending_review, completed, and cancelled.
     */
    const STATUS_FILTERS = [
      { value: 'created' },
      { value: 'assigned' },
      { value: 'processing' },
      { value: 'pending_review' },
      { value: 'completed' },
      { value: 'cancelled' },
    ]

    /**
     * A small pill on a ticket row or header.
     *
     * The status, "mine" and "unassigned" markers all look the same: a
     * rounded label in the colour of what it says.
     */
    function Badge({ color, children }) {
      return h(
        'span',
        {
          style: {
            fontSize: 11,
            lineHeight: '16px',
            padding: '0 6px',
            borderRadius: 999,
            color,
            border: `1px solid ${color}`,
          },
        },
        children,
      )
    }

    /** The sidebar glyph: a ticket stub with two ruled lines. */
    function TicketsPanelIcon({ size }) {
      const edge = size ?? 18
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: edge,
          height: edge,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M5 4.5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z' }),
        h('path', { d: 'M8 9h8M8 13h5' }),
      )
    }

    /**
     * The inline write forms of one ticket row.
     *
     * Every form the panel offers lives here, opened from the row itself:
     * 分派 picks a new owner, 工时 books hours on the underlying task, and
     * 评论 appends a processing note.
     *
     * The forms live inside the clickable row, so every event they raise stops
     * there — otherwise picking a person would bubble into the row's click and
     * open the ticket detail.
     */
    function RowActions({ ticket, t, mode, onAct, onUpload, onUsers, onDone, onCancel, onRootCauseState, onMode }) {
      const [keyword, setKeyword] = useState('')
      const [users, setUsers] = useState(null)
      const [owner, setOwner] = useState('')
      /** The person that was picked, so the name survives a reloaded list. */
      const [picked, setPicked] = useState(null)
      const [comment, setComment] = useState('')
      /** The root-cause analysis: 确认完成 的 prerequisites. */
      const [rootCause, setRootCause] = useState('')
      const [workDate, setWorkDate] = useState(todayString())
      const [hours, setHours] = useState('')
      const [remark, setRemark] = useState('')
      const [overtime, setOvertime] = useState(false)
      const [pending, setPending] = useState(false)
      const [feedback, setFeedback] = useState(null)
      /** The images pasted into the comment, as data URLs. */
      const [images, setImages] = useState([])
      /** The people @-mentioned in the comment: `[{ userId, name }]`. */
      const [mentions, setMentions] = useState([])
      /** The open `@` query: where the `@` sits and what follows it. */
      const [mention, setMention] = useState(null)
      /** The people the `@` picker matched. */
      const [mentionHits, setMentionHits] = useState(null)

      // The assign picker needs the directory; it is desensitized upstream and
      // capped at one page, so a keyword narrows it instead of paging. The
      // keyword is debounced: one request per pause in typing, not one per
      // keystroke, and the page that is on screen stays while the next loads.
      useEffect(() => {
        if (mode !== 'assign') return undefined
        let cancelled = false
        const timer = setTimeout(() => {
          onUsers(keyword).then(
            list => { if (!cancelled) setUsers(list) },
            () => { if (!cancelled) setUsers([]) },
          )
        }, keyword === '' ? 0 : 220)
        return () => { cancelled = true; clearTimeout(timer) }
      }, [onUsers, keyword, mode])

      // The `@` picker needs the same directory; the query after the `@`
      // narrows it, and an empty query lists the first page.
      useEffect(() => {
        if (mode !== 'comment' || mention === null) return undefined
        let cancelled = false
        setMentionHits(null)
        onUsers(mention.query).then(
          list => { if (!cancelled) setMentionHits(list) },
          () => { if (!cancelled) setMentionHits([]) },
        )
        return () => { cancelled = true }
        // The query alone is the trigger: re-running on every render would keep
        // asking the server for the same page.
      }, [mention === null ? null : mention.query, mode, onUsers])

      const input = {
        boxSizing: 'border-box',
        padding: '5px 8px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
      }
      const button = {
        fontSize: 12,
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      }

      /** Run one write and report the outcome back to the panel. */
      const send = request => {        setPending(true)
        setFeedback(null)
        onAct(request).then(
          result => {
            const action = result?.action ?? {}
            if (action.ok === false) {
              setPending(false)
              setFeedback({ ok: false, message: action.message ?? '' })
              // The server refused because the ticket has no root-cause entry
              // yet: 原因分析 comes first, so open that step.
              if (action.needRootCause === true) {
                onRootCauseState?.('missing')
                onMode?.('rootCause')
              }
              return
            }
            if (mode === 'rootCause') onRootCauseState?.('ready')
            onDone?.(action.message ?? '')
          },
          error => {
            setPending(false)
            setFeedback({ ok: false, message: error instanceof Error ? error.message : String(error) })
          },
        )
      }

      /**
       * Follow the `@` the caret is sitting in.
       *
       * An `@` starts a query unless it is part of a word: an e-mail address
       * (`user@example.com`) must not open the picker, while Chinese text runs
       * straight into the mark (`已处理@易粮坤`), so only ASCII word characters
       * and the characters an address is built from block it.
       */
      const trackMention = (value, caret) => {
        const before = value.slice(0, caret)
        const at = before.lastIndexOf('@')
        if (at < 0) {
          setMention(null)
          return
        }
        const prev = at === 0 ? '' : before[at - 1]
        const query = before.slice(at + 1)
        if (prev !== '' && /[A-Za-z0-9._+-]/.test(prev)) {
          setMention(null)
          return
        }
        if (/\s/.test(query) || query.length > 20) {
          setMention(null)
          return
        }
        setMention({ start: at, end: caret, query })
      }

      /** Drop one person into the text and remember who they are. */
      const pickMention = person => {
        if (mention === null || !person) return
        const inserted = `@${person.name} `
        const next = comment.slice(0, mention.start) + inserted + comment.slice(mention.end)
        setComment(next)
        setMentions(previous => (
          previous.some(item => item.userId === person.userId)
            ? previous
            : [...previous, { userId: person.userId, name: person.name }]
        ))
        setMention(null)
      }

      /** Read the images out of a paste and hold them for the upload. */
      const addImages = files => {
        if (files.length === 0) return
        Promise.all(files.map(file =>
          readImage(file).then(
            base64 => ({
              name: file.name || 'pasted-image.png',
              type: file.type || 'image/png',
              base64,
              url: URL.createObjectURL(file),
            }),
            error => ({
              name: file.name || 'pasted-image.png',
              type: file.type || 'image/png',
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        )).then(picked => {
          const failed = picked.filter(item => item.error)
          const ok = picked.filter(item => !item.error)
          setImages(previous => [...previous, ...ok])
          if (failed.length > 0) {
            setFeedback({
              ok: false,
              message: `${t('actions.imageFailed')}: ${failed.map(item => `${item.name} (${item.error})`).join('; ')}`,
            })
          }
        })
      }

      const submit = () => {
        if (mode === 'assign') {
          send({
            op: 'assign',
            ticketNo: ticket.ticketNo,
            ticketId: ticket.ticketId,
            ownerUserId: Number(owner),
          })
          return
        }
        if (mode === 'comment') {
          // The comment is written first; the images are attached afterwards,
          // because an attachment hangs on the ticket, not on the comment.
          setPending(true)
          setFeedback(null)
          onAct({
            op: 'comment',
            ticketNo: ticket.ticketNo,
            ticketId: ticket.ticketId,
            // The body goes out as the rich text gongsi stores, so an
            // @-mentioned person is linked to their account, not just named.
            content: commentHtml(comment.trim(), mentions),
            idempotencyKey: idempotencyKey(),
          }).then(
            result => {
              const action = result?.action ?? {}
              if (action.ok === false) {
                setPending(false)
                setFeedback({ ok: false, message: action.message ?? '' })
                return
              }
              if (images.length === 0) {
                setPending(false)
                onDone?.(action.message ?? '')
                return
              }
              setFeedback({ ok: true, message: `${action.message ?? ''} (${t('actions.uploadingImages')})` })
              Promise.all(images.map(image =>
                onUpload({
                  ticketId: ticket.ticketId,
                  ticketNo: ticket.ticketNo,
                  fileName: image.name,
                  mimeType: image.type,
                  fileBase64: image.base64,
                }).then(
                  () => ({ ok: true }),
                  error => ({ ok: false, name: image.name, message: error instanceof Error ? error.message : String(error) }),
                ),
              )).then(results => {
                setPending(false)
                const failed = results.filter(result => !result.ok)
                if (failed.length > 0) {
                  setFeedback({
                    ok: false,
                    message: `${t('actions.uploadFailed')}: ${failed.map(item => `${item.name} (${item.message})`).join('; ')}`,
                  })
                  return
                }
                onDone?.(action.message ?? '')
              })
            },
            error => {
              setPending(false)
              setFeedback({ ok: false, message: error instanceof Error ? error.message : String(error) })
            },
          )
          return
        }
        if (mode === 'worklog') {
          send({
            op: 'worklog',
            ticketNo: ticket.ticketNo,
            ticketId: ticket.ticketId,
            taskId: ticket.taskId,
            workDate,
            hours: Number(hours),
            remark: remark.trim(),
            isOvertime: overtime,
          })
          return
        }
        if (mode === 'start') {
          send({
            op: 'status',
            ticketNo: ticket.ticketNo,
            ticketId: ticket.ticketId,
            action: 'start',
          })
          return
        }
        if (mode === 'rootCause') {
          // The analysis is its own write, so 确认完成 only has to close what
          // this step recorded. The Host keys the entry on the text, so a
          // retry of the same text does not write a second one.
          send({
            op: 'rootCause',
            ticketNo: ticket.ticketNo,
            ticketId: ticket.ticketId,
            taskId: ticket.taskId,
            content: rootCause.trim(),
          })
          return
        }
        if (mode === 'complete') {
          // No input: the analysis is already on the task, and the Host reads
          // it back as the conclusion.
          send({
            op: 'status',
            ticketNo: ticket.ticketNo,
            ticketId: ticket.ticketId,
            action: 'complete',
          })
        }
      }

      const shell = {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 12px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: '0 0 8px 8px',
      }
      const guards = {
        onClick: event => event.stopPropagation(),
        onMouseDown: event => event.stopPropagation(),
        onKeyDown: event => event.stopPropagation(),
      }
      const bar = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }

      /**
       * The people the assign picker offers.
       *
       * The picked one is kept in the list even when the directory is loaded
       * again: the box shows the name of the person that was picked, and the
       * name is not worth losing because the list moved on.
       */
      const assignOptions = (() => {
        const list = (users ?? []).map(user => ({
          value: String(user.userId),
          label: `${user.name} (${user.userId})`,
        }))
        if (owner !== '' && !list.some(option => option.value === owner)) {
          const known = picked !== null && String(picked.userId) === owner ? picked : null
          list.push({ value: owner, label: known === null ? owner : `${known.name} (${owner})` })
        }
        return list
      })()

      return h(
        'div',
        { style: shell, ...guards },
        mode === 'assign'
          ? h(
              'div',
              { style: { ...bar, alignItems: 'center' } },
              // One control for both jobs: typing searches, picking chooses.
              // The label shares the row with the box and the buttons.
              h(
                'div',
                { style: { width: 260, flex: '0 1 auto', minWidth: 0 } },
                h(RefSelect, {
                  t,
                  inline: true,
                  label: t('actions.assign'),
                  placeholder: t('actions.usersSearch'),
                  options: assignOptions,
                  loading: users === null,
                  selected: owner,
                  onSearch: value => setKeyword(value),
                  onPick: value => {
                    setOwner(value)
                    const user = (users ?? []).find(entry => String(entry.userId) === value)
                    setPicked(user === undefined ? null : { userId: user.userId, name: user.name })
                  },
                }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  disabled: owner === '' || pending,
                  onClick: submit,
                  style: { ...button, opacity: owner === '' ? 0.5 : 1 },
                },
                pending ? t('actions.submitting') : t('actions.assignSubmit'),
              ),
              h('button', { type: 'button', onClick: () => onCancel?.(), style: button }, t('row.cancel')),
            )
          : null,
        mode === 'comment'
          ? h(
              'div',
              { style: { ...bar, alignItems: 'flex-start' } },
              h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('actions.comment')),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 160 } },
                h('textarea', {
                  value: comment,
                  rows: 2,
                  placeholder: t('actions.commentPlaceholder'),
                  style: { ...input, resize: 'vertical', width: '100%' },
                  onClick: event => event.stopPropagation(),
                  onKeyDown: event => {
                    event.stopPropagation()
                    if (mention !== null && event.key === 'Escape') {
                      event.preventDefault()
                      setMention(null)
                    }
                  },
                  onChange: event => {
                    event.stopPropagation()
                    const value = event.target.value
                    setComment(value)
                    trackMention(value, event.target.selectionStart ?? value.length)
                  },
                  // A pasted screenshot becomes an attachment on the ticket.
                  onPaste: event => {
                    const files = pastedImages(event)
                    if (files.length === 0) return
                    event.preventDefault()
                    event.stopPropagation()
                    addImages(files)
                  },
                }),
                // The `@` picker: the people a mention can point at.
                mention !== null
                  ? h(
                      'div',
                      {
                        style: {
                          display: 'flex',
                          flexDirection: 'column',
                          maxHeight: 160,
                          overflowY: 'auto',
                          borderRadius: 6,
                          border: '1px solid var(--dsw-alias-border-l1)',
                          background: 'var(--dsw-alias-bg-layer-1)',
                        },
                        // The row underneath opens the ticket on a click.
                        onClick: event => event.stopPropagation(),
                      },
                      mentionHits === null
                        ? h('div', { style: { padding: '5px 8px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('actions.usersLoading'))
                        : null,
                      mentionHits !== null && mentionHits.length === 0
                        ? h('div', { style: { padding: '5px 8px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('actions.usersNone'))
                        : null,
                      (mentionHits ?? []).map(person =>
                        h(
                          'button',
                          {
                            key: person.userId,
                            type: 'button',
                            onClick: event => {
                              event.stopPropagation()
                              pickMention(person)
                            },
                            style: {
                              padding: '5px 8px',
                              fontSize: 12,
                              textAlign: 'left',
                              border: 'none',
                              borderRadius: 4,
                              background: 'transparent',
                              color: 'var(--dsw-alias-label-primary)',
                              cursor: 'pointer',
                            },
                          },
                          `${person.name} (${person.userId})`,
                        )),
                    )
                  : null,
                mentions.length > 0
                  ? h(
                      'div',
                      { style: { display: 'flex', flexWrap: 'wrap', gap: 6 }, onClick: event => event.stopPropagation() },
                      mentions.map(person =>
                        h(
                          'span',
                          {
                            key: person.userId,
                            style: {
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              padding: '1px 6px',
                              fontSize: 11,
                              borderRadius: 999,
                              color: 'var(--dsw-alias-brand-primary)',
                              border: '1px solid var(--dsw-alias-brand-primary)',
                            },
                          },
                          `@${person.name}`,
                          h(
                            'button',
                            {
                              type: 'button',
                              onClick: event => {
                                event.stopPropagation()
                                setMentions(previous => previous.filter(item => item.userId !== person.userId))
                              },
                              style: {
                                padding: 0,
                                border: 'none',
                                background: 'transparent',
                                color: 'inherit',
                                cursor: 'pointer',
                                fontSize: 11,
                                lineHeight: '12px',
                              },
                            },
                            '×',
                          ),
                        )),
                    )
                  : null,
                images.length > 0
                  ? h(
                      'div',
                      { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                      images.map((image, index) =>
                        h(
                          'div',
                          {
                            key: `${image.name}-${index}`,
                            style: {
                              position: 'relative',
                              width: 56,
                              height: 56,
                              borderRadius: 6,
                              overflow: 'hidden',
                              border: '1px solid var(--dsw-alias-border-l1)',
                              background: 'var(--dsw-alias-bg-layer-2)',
                            },
                          },
                          h('img', {
                            src: image.url,
                            alt: image.name,
                            style: { width: '100%', height: '100%', objectFit: 'cover' },
                          }),
                          h(
                            'button',
                            {
                              type: 'button',
                              onClick: event => {
                                event.stopPropagation()
                                setImages(previous => previous.filter((_, at) => at !== index))
                              },
                              style: {
                                position: 'absolute',
                                top: 2,
                                right: 2,
                                width: 16,
                                height: 16,
                                lineHeight: '14px',
                                fontSize: 10,
                                textAlign: 'center',
                                padding: 0,
                                borderRadius: 999,
                                border: '1px solid var(--dsw-alias-border-l1)',
                                background: 'var(--dsw-alias-bg-layer-1)',
                                color: 'var(--dsw-alias-label-primary)',
                                cursor: 'pointer',
                              },
                            },
                            '×',
                          ),
                        )),
                    )
                  : null,
              ),
              h(
                'button',
                {
                  type: 'button',
                  disabled: comment.trim() === '' || pending,
                  onClick: submit,
                  style: { ...button, opacity: comment.trim() === '' ? 0.5 : 1 },
                },
                pending ? t('actions.submitting') : t('actions.commentSubmit'),
              ),
              h('button', { type: 'button', onClick: () => onCancel?.(), style: button }, t('row.cancel')),
            )
          : null,
        mode === 'worklog'
          ? h(
              'div',
              { style: bar },
              h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('actions.worklog')),
              h('input', {
                type: 'date',
                value: workDate,
                style: { ...input, width: 140 },
                onClick: event => event.stopPropagation(),
                onKeyDown: event => event.stopPropagation(),
                onChange: event => {
                  event.stopPropagation()
                  setWorkDate(event.target.value)
                },
              }),
              h('input', {
                type: 'number',
                value: hours,
                min: '0.5',
                step: '0.5',
                placeholder: t('actions.worklogHours'),
                style: { ...input, width: 80 },
                onClick: event => event.stopPropagation(),
                onKeyDown: event => event.stopPropagation(),
                onChange: event => {
                  event.stopPropagation()
                  setHours(event.target.value)
                },
              }),
              h('input', {
                type: 'text',
                value: remark,
                placeholder: t('actions.worklogRemark'),
                style: { ...input, flex: 1, minWidth: 140 },
                onClick: event => event.stopPropagation(),
                onKeyDown: event => event.stopPropagation(),
                onChange: event => {
                  event.stopPropagation()
                  setRemark(event.target.value)
                },
              }),
              h(
                'label',
                { style: { fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 } },
                h('input', {
                  type: 'checkbox',
                  checked: overtime,
                  onClick: event => event.stopPropagation(),
                  onChange: event => {
                    event.stopPropagation()
                    setOvertime(event.target.checked)
                  },
                }),
                t('actions.overtime'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  disabled: Number(hours) <= 0 || pending,
                  onClick: submit,
                  style: { ...button, opacity: Number(hours) <= 0 ? 0.5 : 1 },
                },
                pending ? t('actions.submitting') : t('actions.worklogSubmit'),
              ),
              h('button', { type: 'button', onClick: () => onCancel?.(), style: button }, t('row.cancel')),
            )
          : null,
        mode === 'start'
          ? h(
              'div',
              { style: bar },
              h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('row.start')),
              h(
                'button',
                {
                  type: 'button',
                  disabled: pending,
                  onClick: submit,
                  style: button,
                },
                pending ? t('actions.submitting') : t('row.startConfirm'),
              ),
              h('button', { type: 'button', onClick: () => onCancel?.(), style: button }, t('row.cancel')),
            )
          : null,
        mode === 'rootCause'
          ? h(
              'div',
              // The step between 开始处理 and 确认完成: one box, the 原因分析.
              // The server refuses to close a ticket whose task carries no such
              // entry, so this is what makes 确认完成 possible.
              { style: bar },
              h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('row.rootCause')),
              h('textarea', {
                value: rootCause,
                rows: 2,
                placeholder: t('row.rootCausePlaceholder'),
                style: { ...input, resize: 'vertical', flex: 1, minWidth: 160 },
                onClick: event => event.stopPropagation(),
                onKeyDown: event => event.stopPropagation(),
                onChange: event => {
                  event.stopPropagation()
                  setRootCause(event.target.value)
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  disabled: rootCause.trim() === '' || pending,
                  onClick: submit,
                  style: { ...button, opacity: rootCause.trim() === '' ? 0.5 : 1 },
                },
                pending ? t('actions.submitting') : t('row.rootCauseSave'),
              ),
              h('button', { type: 'button', onClick: () => onCancel?.(), style: button }, t('row.cancel')),
            )
          : null,
        mode === 'complete'
          ? h(
              'div',
              // Nothing to fill in: 确认完成 closes the ticket with the analysis
              // that 原因分析 already recorded.
              { style: bar },
              h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('row.rootCauseReady')),
              h(
                'button',
                {
                  type: 'button',
                  disabled: pending,
                  onClick: submit,
                  style: { ...button, opacity: pending ? 0.5 : 1 },
                },
                pending ? t('actions.submitting') : t('row.completeConfirm'),
              ),
              h('button', { type: 'button', onClick: () => onCancel?.(), style: button }, t('row.cancel')),
            )
          : null,
        feedback
          ? h(
              'div',
              {
                style: {
                  fontSize: 12,
                  color: feedback.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
                  whiteSpace: 'pre-wrap',
                },
              },
              feedback.message
                ? `${feedback.ok ? t('actions.done') : t('actions.failed')}: ${feedback.message}`
                : (feedback.ok ? t('actions.done') : t('actions.failed')),
            )
          : null,
      )
    }

    /**
     * The console a share link points at.
     *
     * The endpoint names the API path (`/api/mcp`); the console is the site
     * above it. The endpoint comes from the settings form, so a deployment
     * that moved its API still hands out links to its own console.
     *
     * @param configForm - the settings form of this plugin, if there is one.
     * @returns the console base URL, without a trailing slash.
     */
    function consoleBase(configForm) {
      let endpoint = ''
      try {
        endpoint = String(configForm?.getSnapshot?.()?.value?.endpoint ?? '').trim()
      } catch {
        endpoint = ''
      }
      if (!endpoint) return DEFAULT_CONSOLE
      const base = endpoint
        .replace(/\/api\/mcp\/?$/i, '')
        .replace(/\/api\/?$/i, '')
        .replace(/\/+$/, '')
      return base || DEFAULT_CONSOLE
    }

    /**
     * The console link of one ticket.
     *
     * The console reads `tab` and `ticketId` from the query string and opens
     * that ticket straight away, so the link needs nothing else. A ticket
     * without a numeric id has no such link — the server keys the ticket on
     * its id, not on its number.
     *
     * @param base - the console base URL.
     * @param ticket - the ticket row or detail.
     * @returns the link, or an empty string when there is none.
     */
    function ticketLink(base, ticket) {
      const id = Number(ticket?.ticketId ?? 0)
      if (!Number.isInteger(id) || id <= 0) return ''
      return `${base}/?tab=ticket-detail&ticketId=${id}`
    }

    /**
     * Put one text on the clipboard.
     *
     * The async clipboard is the normal way, but it needs a secure context
     * and a permission the page may not have. The old selection trick is the
     * fallback: it works everywhere, as long as the text is selected.
     *
     * @param text - what to copy.
     * @returns whether the text reached the clipboard.
     */
    async function copyText(text) {
      const value = String(text ?? '')
      if (!value) return false
      try {
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
        if (clipboard && typeof clipboard.writeText === 'function') {
          await clipboard.writeText(value)
          return true
        }
      } catch {
        // The page is not allowed to use the async clipboard; try the fallback.
      }
      try {
        if (typeof document === 'undefined') return false
        const area = document.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const copied = document.execCommand('copy')
        document.body.removeChild(area)
        return copied === true
      } catch {
        return false
      }
    }

    /**
     * The share button: copy the console link of one ticket.
     *
     * The button says what it did — copied, or failed — and the message fades
     * on its own, so the row stays quiet afterwards.
     */
    function ShareButton({ url, t, style }) {
      const [state, setState] = useState('idle')

      useEffect(() => {
        if (state === 'idle') return undefined
        const timer = setTimeout(() => setState('idle'), 2000)
        return () => clearTimeout(timer)
      }, [state])

      const copy = async event => {
        // The row opens the detail on click; this button must not.
        event.preventDefault()
        event.stopPropagation()
        const ok = await copyText(url)
        setState(ok ? 'copied' : 'failed')
      }

      return h(
        'button',
        {
          type: 'button',
          title: url || t('row.shareHint'),
          onClick: copy,
          style,
        },
        state === 'copied'
          ? t('row.shareCopied')
          : state === 'failed'
            ? t('row.shareFailed')
            : t('row.share'),
      )
    }

    /**
     * One ticket row.
     *
     * The row itself is the link: clicking it — or pressing Enter on it —
     * opens the ticket's detail. The row's right-hand links carry the writes:
     * 分派 (assign), 工时 (book hours), 评论 (append a note) — plus
     * 开始处理 / 确认完成, which depend on the ticket's status — and 分享,
     * which copies the console link of the ticket.
     */
    function TicketRow(props) {
      const { ticket, t, onOpen, onAct, onUpload, onUsers, onWritten, rowMode, onRowMode, onDone, onQuote, quoting, consoleUrl, rootCauseReady, onRootCauseState } = props
      const statusColor = STATUS_COLORS[ticket.status] ?? 'var(--dsw-alias-label-secondary)'
      const statusLabel = STATUS_LABELS[ticket.status] ?? ticket.status
      const priorityLabel = PRIORITY_LABELS[ticket.priority] ?? ticket.priority
      const linkStyle = {
        fontSize: 12,
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        cursor: 'pointer',
      }
      /** A row link that opens one of the row's own forms. */
      const modeLink = (label, mode) =>
        h(
          'button',
          {
            type: 'button',
            // The row itself opens the detail; the link must not.
            onClick: event => {
              event.stopPropagation()
              onRowMode?.(mode)
            },
            style: linkStyle,
          },
          label,
        )

      // A ticket that is waiting for a start can be picked up; one that is
      // being worked on gets one of the two closing steps, never both: the
      // root-cause analysis until it is on the ticket, then 确认完成 alone.
      const ownsTicket = ticket.mine === true
      const canStart = ownsTicket && (ticket.status === 'assigned' || ticket.status === 'created')
      const canComplete = ownsTicket && ticket.status === 'processing'
      /** 确认完成 takes the place of 原因分析 once the analysis is recorded. */
      const closeReady = rootCauseReady === 'ready'

      /**
       * Nobody owns the ticket yet.
       *
       * The owner comes back as a name and an id; a ticket that has neither
       * is waiting to be handed to somebody.
       */
      const unassigned = !ticket.ownerName && !ticket.ownerUserId

      /** The console link of this ticket, when it has one. */
      const shareUrl = ticketLink(consoleUrl, ticket)

      return h(
        'li',
        {
          role: 'button',
          tabIndex: 0,
          'aria-label': `${t('row.openDetail')}: ${ticket.ticketNo} ${ticket.title}`,
          onClick: () => onOpen?.(ticket),
          onKeyDown: event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpen?.(ticket)
            }
          },
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
            listStyle: 'none',
            cursor: 'pointer',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, ticket.ticketNo),
          h(Badge, { color: statusColor }, statusLabel),
          // Nobody owns it yet: the badge says so at a glance.
          unassigned
            ? h(Badge, { color: 'var(--dsw-alias-state-error-primary)' }, t('badge.unassigned'))
            : null,
          ticket.mine
            ? h(Badge, { color: 'var(--dsw-alias-brand-primary)' }, t('badge.mine'))
            : null,
          priorityLabel
            ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, priorityLabel)
            : null,
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, ticket.createdAt),
          canStart
            ? h(
                'button',
                {
                  type: 'button',
                  onClick: event => {
                    event.stopPropagation()
                    onRowMode?.('start')
                  },
                  style: linkStyle,
                },
                t('row.start'),
              )
            : null,
          canComplete && !closeReady
            ? h(
                'button',
                {
                  type: 'button',
                  // The step before the completion: fill the analysis. Once it
                  // is recorded this link gives way to 确认完成.
                  onClick: event => {
                    event.stopPropagation()
                    onRowMode?.('rootCause')
                  },
                  style: linkStyle,
                },
                t('row.rootCause'),
              )
            : null,
          canComplete && closeReady
            ? h(
                'button',
                {
                  type: 'button',
                  // 确认完成 takes no input: it closes the ticket with the
                  // analysis 原因分析 already recorded.
                  onClick: event => {
                    event.stopPropagation()
                    onRowMode?.('complete')
                  },
                  style: linkStyle,
                },
                t('row.complete'),
              )
            : null,
          modeLink(t('row.worklog'), 'worklog'),
          modeLink(t('row.comment'), 'comment'),
          modeLink(t('row.assign'), 'assign'),
          // Quote: carry this ticket into a fresh conversation.
          h(
            'button',
            {
              type: 'button',
              title: t('row.quoteHint'),
              disabled: quoting === ticket.ticketNo,
              onClick: event => {
                event.stopPropagation()
                onQuote?.(ticket)
              },
              style: { ...linkStyle, opacity: quoting === ticket.ticketNo ? 0.5 : 1 },
            },
            quoting === ticket.ticketNo ? t('row.quoting') : t('row.quote'),
          ),
          // Share: hand the console link of this ticket to the clipboard.
          shareUrl
            ? h(ShareButton, { url: shareUrl, t, style: linkStyle })
            : null,
        ),
        h('div', { style: { fontSize: 13, lineHeight: '18px', color: 'var(--dsw-alias-label-primary)' } }, ticket.title),
        h(
          'div',
          {
            style: {
              display: 'flex',
              gap: 10,
              fontSize: 11,
              color: 'var(--dsw-alias-label-secondary)',
              flexWrap: 'wrap',
            },
          },
          ticket.schoolName ? h('span', null, ticket.schoolName) : null,
          ticket.productName ? h('span', null, ticket.productName) : null,
          ticket.initiatorName ? h('span', null, `${t('initiator')}: ${ticket.initiatorName}`) : null,
          ticket.ownerName ? h('span', null, `${t('owner')}: ${ticket.ownerName}`) : null,
        ),
        rowMode
          ? h(RowActions, {
              ticket,
              t,
              mode: rowMode,
              onAct: onAct,
              onUpload: onUpload,
              onUsers: onUsers,
              onRootCauseState: onRootCauseState,
              onMode: onRowMode,
              onDone: message => {
                onRowMode?.(null)
                onDone?.(message)
              },
              onCancel: () => onRowMode?.(null),
            })
          : null,
      )
    }

    /** One file size in bytes as a short human string. */
    function formatSize(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    /** One label/value meta row; empty values collapse away. */
    function MetaRow({ label, value }) {
      if (value === undefined || value === null || value === '') return null
      return h(
        'div',
        { style: { display: 'flex', gap: 10, fontSize: 12, lineHeight: '20px' } },
        h('span', { style: { minWidth: 76, flexShrink: 0, color: 'var(--dsw-alias-label-secondary)' } }, label),
        h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, value),
      )
    }

    /** Today's local date as YYYY-MM-DD, the worklog default. */
    function todayString() {
      const now = new Date()
      const pad = part => String(part).padStart(2, '0')
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    }

    /** One random idempotency key per comment submission. */
    function idempotencyKey() {
      const random = typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      return `dsh-gongsi-${random}`
    }

    /** Escape one string for a text position in HTML. */
    function escapeText(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
    }

    /** Escape one string for an HTML attribute value. */
    function escapeAttr(value) {
      return escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    }

    /**
     * The comment body as the rich text gongsi stores.
     *
     * A mention is a `biz-mention` span — the same markup the PC editor writes,
     * so the mentioned person is linked to their account and gets told about
     * it. Everything else is escaped plain text, so a comment can never smuggle
     * markup of its own into the log.
     *
     * @param text - what the user typed, with `@Name` left in place.
     * @param mentions - `[{ userId, name }]` for the people actually picked.
     * @returns the HTML body.
     */
    function commentHtml(text, mentions) {
      let html = escapeText(text)
      for (const mention of mentions ?? []) {
        const token = `@${escapeText(mention.name)}`
        const at = html.indexOf(token)
        if (at < 0) continue
        const span = '<span class="biz-mention" data-w-e-type="bizMention"'
          + ' data-mention-type="user"'
          + ` data-mention-id="${escapeAttr(mention.userId)}"`
          + ` data-mention-title="${escapeAttr(mention.name)}">`
          + `@${escapeText(mention.name)}</span>`
        html = html.slice(0, at) + span + html.slice(at + token.length)
      }
      // One paragraph per blank-line-separated block, single breaks inside.
      return html
        .split(/\n{2,}/)
        .map(block => `<p>${block.replace(/\n/g, '<br>')}</p>`)
        .join('')
    }

    /**
     * The draft a quote starts from.
     *
     * It is the module reference and nothing else: the skill body already
     * carries the instructions (read the ticket live, consult the knowledge
     * base, confirm before writing), so no prose is spilled into the composer.
     * The ticket number is the one piece the skill cannot know by itself.
     *
     * @param row - the list row, for the ticket number.
     * @returns the draft text.
     */
    function quotePrompt(row) {
      return `${QUOTE_SKILL} ${row.ticketNo}`
    }

    /** The biggest file the server accepts, in bytes. */
    const MAX_IMAGE_BYTES = 10 * 1024 * 1024

    /**
     * Read one picked image into the base64 payload the server wants.
     *
     * The data URL prefix is stripped: the server expects the raw base64.
     */
    function readImage(file) {
      return new Promise((resolve, reject) => {
        if (file.size > MAX_IMAGE_BYTES) {
          reject(new Error(`${file.name} is larger than 10MB`))
          return
        }
        const reader = new FileReader()
        reader.onerror = () => reject(new Error(`could not read ${file.name}`))
        reader.onload = () => {
          const result = String(reader.result ?? '')
          const comma = result.indexOf(',')
          resolve(comma >= 0 ? result.slice(comma + 1) : result)
        }
        reader.readAsDataURL(file)
      })
    }

    /**
     * The images in a paste.
     *
     * A screenshot pasted into a text field arrives as an item of kind
     * `file`; the text of the paste is not an image and is left alone.
     */
    function pastedImages(event) {
      const items = event?.clipboardData?.items
      if (!items) return []
      const files = []
      for (const item of Array.from(items)) {
        if (item?.kind !== 'file') continue
        if (item?.type && !item.type.startsWith('image/')) continue
        const file = item.getAsFile?.()
        if (file) files.push(file)
      }
      return files
    }

    /**
     * The read-only detail of one ticket.
     *
     * List-only fields (school, product, dates, the `mine` flag) come from the
     * clicked row; everything else comes from the Host detail payload.
     */
    function TicketDetailView({ detail, row, t }) {
      /** The image being enlarged, and the set it came from. */
      const [viewing, setViewing] = useState(null)
      const statusColor = STATUS_COLORS[detail.status] ?? 'var(--dsw-alias-label-secondary)'
      const statusLabel = STATUS_LABELS[detail.status] ?? detail.status
      /** Nobody owns the ticket yet. */
      const unassigned = !detail.ownerName && !row?.ownerUserId
      const logTypeLabel = {
        ai: t('detail.logType.ai'),
        issue: t('detail.logType.issue'),
        progress: t('detail.logType.progress'),
      }
      const sectionTitle = { margin: '4px 0', fontSize: 13, fontWeight: 600 }
      /** Enlarge one image in place. */
      const openImage = (images, index) => setViewing({ images, index })
      /** Walk the set the current image came from. */
      const stepImage = step => {
        setViewing(current => {
          if (current === null) return current
          const size = current.images.length
          return { ...current, index: ((current.index + step) % size + size) % size }
        })
      }

      // Escape closes the viewer and the arrows walk it, wherever the focus is:
      // a click on a thumbnail does not have to land focus inside the overlay.
      useEffect(() => {
        if (viewing === null) return undefined
        const onKey = event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setViewing(null)
          } else if (event.key === 'ArrowRight') {
            stepImage(1)
          } else if (event.key === 'ArrowLeft') {
            stepImage(-1)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [viewing === null ? null : viewing.index, viewing === null ? null : viewing.images])
      const cardStyle = {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(
          'div',
          null,
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, detail.ticketNo),
            h(Badge, { color: statusColor }, statusLabel),
            // Nobody owns it yet: the badge says so at a glance.
            unassigned
              ? h(Badge, { color: 'var(--dsw-alias-state-error-primary)' }, t('badge.unassigned'))
              : null,
            row?.mine
              ? h(Badge, { color: 'var(--dsw-alias-brand-primary)' }, t('badge.mine'))
              : null,
          ),
          h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, detail.title),
        ),
        h(
          'div',
          { style: cardStyle },
          h(MetaRow, { label: t('detail.initiator'), value: detail.initiatorName }),
          h(MetaRow, { label: t('owner'), value: detail.ownerName }),
          h(MetaRow, { label: t('detail.assignees'), value: detail.assignees.join('、') }),
          h(MetaRow, { label: t('detail.issueType'), value: detail.issueTypeName }),
          h(MetaRow, { label: t('detail.school'), value: row?.schoolName }),
          h(MetaRow, { label: t('detail.product'), value: row?.productName }),
          h(MetaRow, { label: t('detail.createdAt'), value: row?.createdAt }),
          h(MetaRow, { label: t('detail.dueTime'), value: row?.dueTime }),
          h(MetaRow, {
            label: t('detail.worklogs'),
            value: `${detail.worklogTotalHours} h · ${detail.worklogPersonDays}${t('detail.personDays')}`,
          }),
          h(MetaRow, {
            label: t('detail.aiStatus'),
            value: detail.aiAnalyzedAt ? `${detail.aiAnalysisStatus} · ${detail.aiAnalyzedAt}` : detail.aiAnalysisStatus,
          }),
        ),
        h(
          'section',
          null,
          h('h3', { style: sectionTitle }, t('detail.description')),
          h(
            'p',
            { style: { margin: 0, fontSize: 13, lineHeight: '20px', whiteSpace: 'pre-wrap' } },
            detail.descriptionText || t('detail.none'),
          ),
          h(ImageList, { images: detail.descriptionImages, t, onOpen: openImage }),
        ),
        detail.feedback
          ? h(
              'section',
              null,
              h('h3', { style: sectionTitle }, t('detail.feedback')),
              h(
                'p',
                { style: { margin: 0, fontSize: 13, lineHeight: '20px', whiteSpace: 'pre-wrap' } },
                detail.feedback,
              ),
              h(ImageList, { images: detail.feedbackImages, t, onOpen: openImage }),
            )
          : null,
        detail.attachments.length > 0
          ? h(
              'section',
              null,
              h('h3', { style: sectionTitle }, `${t('detail.attachments')} (${detail.attachments.length})`),
              h(
                'ul',
                { style: { margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                detail.attachments.map((file, index) =>
                  h(
                    'li',
                    { key: `${file.name}-${index}` },
                    `${file.name}${typeof file.size === 'number' ? ` (${formatSize(file.size)})` : ''}${file.uploaderName ? ` · ${file.uploaderName}` : ''}`,
                  )),
              ),
            )
          : null,
        h(
          'section',
          null,
          h('h3', { style: sectionTitle }, `${t('detail.logs')} (${detail.logs.length})`),
          detail.logs.length === 0
            ? h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('detail.none'))
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                detail.logs.map(log =>
                  h(
                    'div',
                    {
                      key: String(log.id),
                      style: {
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--dsw-alias-border-l1)',
                        background: 'var(--dsw-alias-bg-layer-1)',
                      },
                    },
                    h(
                      'div',
                      {
                        style: {
                          display: 'flex',
                          gap: 8,
                          marginBottom: 4,
                          fontSize: 11,
                          flexWrap: 'wrap',
                          color: 'var(--dsw-alias-label-secondary)',
                        },
                      },
                      h('span', null, log.createdAt),
                      h('span', null, log.authorName),
                      h('span', { style: { color: 'var(--dsw-alias-brand-primary)' } }, logTypeLabel[log.logType] ?? log.logType),
                    ),
                    h(
                      'div',
                      { style: { fontSize: 12, lineHeight: '19px', whiteSpace: 'pre-wrap' } },
                      log.contentText || t('detail.none'),
                    ),
                    h(ImageList, { images: log.images, t, onOpen: openImage }),
                  )),
              ),
        ),
        // The enlarged picture sits over the whole panel, so the ticket stays
        // behind it and the browser never has to open the file.
        viewing
          ? h(ImageViewer, {
              images: viewing.images,
              index: viewing.index,
              t,
              onClose: () => setViewing(null),
              onStep: stepImage,
            })
          : null,
      )
    }

    /**
     * The screenshots lifted out of one rich-text body.
     *
     * The Host lifts the image URLs out of the body's HTML and the panel draws
     * them as plain `<img>` tags, so no server markup ever reaches the page.
     * Clicking one hands it to the detail view's viewer, which enlarges it in
     * place: the panel never navigates away to the browser.
     */
    function ImageList({ images, t, onOpen }) {
      if (!Array.isArray(images) || images.length === 0) return null
      return h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } },
        images.map((image, index) =>
          h(
            'button',
            {
              key: `${image.src}-${index}`,
              type: 'button',
              title: image.alt || t('detail.viewImage'),
              onClick: () => onOpen?.(images, index),
              style: {
                display: 'block',
                maxWidth: 220,
                padding: 0,
                borderRadius: 6,
                overflow: 'hidden',
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-layer-2)',
                lineHeight: 0,
                cursor: 'zoom-in',
              },
            },
            h('img', {
              src: image.src,
              alt: image.alt ?? '',
              loading: 'lazy',
              style: { display: 'block', maxWidth: '100%', height: 'auto' },
            }),
          )),
      )
    }

    /**
     * One image, enlarged over the panel.
     *
     * A fixed backdrop keeps the picture in place of the page: closing it — by
     * the button, the backdrop, or Escape — returns to the ticket, so the
     * browser never has to open or download the file. The arrow keys walk the
     * other screenshots of the same body.
     */
    function ImageViewer({ images, index, t, onClose, onStep }) {
      if (!Array.isArray(images) || images.length === 0) return null
      const at = Math.min(Math.max(index ?? 0, 0), images.length - 1)
      const image = images[at]
      if (!image) return null

      const control = {
        border: '1px solid rgba(255, 255, 255, 0.28)',
        background: 'rgba(0, 0, 0, 0.45)',
        color: '#fff',
        borderRadius: 6,
        cursor: 'pointer',
        fontSize: 12,
        padding: '4px 10px',
      }

      return h(
        'div',
        {
          // A fixed backdrop: the picture covers the panel rather than
          // navigating anywhere.
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 2000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            background: 'rgba(0, 0, 0, 0.78)',
          },
          role: 'dialog',
          'aria-modal': 'true',
          onClick: () => onClose?.(),
          onKeyDown: event => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              onClose?.()
            } else if (event.key === 'ArrowRight' && images.length > 1) {
              onStep?.(1)
            } else if (event.key === 'ArrowLeft' && images.length > 1) {
              onStep?.(-1)
            }
          },
          tabIndex: -1,
        },
        h(
          'div',
          {
            // Clicks inside the picture must not close the viewer.
            onClick: event => event.stopPropagation(),
            style: { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '100%', maxHeight: '100%' },
          },
          h('img', {
            src: image.src,
            alt: image.alt ?? '',
            style: {
              display: 'block',
              maxWidth: '100%',
              maxHeight: 'calc(100vh - 120px)',
              objectFit: 'contain',
              borderRadius: 4,
              background: 'var(--dsw-alias-bg-layer-1)',
            },
          }),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, color: 'rgba(255,255,255,0.8)', fontSize: 12 } },
            h('span', null, `${at + 1} / ${images.length}`),
            image.alt ? h('span', { style: { opacity: 0.7 } }, image.alt) : null,
            h('span', { style: { flex: 1 } }),
            images.length > 1
              ? h(
                  'button',
                  { type: 'button', onClick: () => onStep?.(-1), style: control },
                  '‹',
                )
              : null,
            images.length > 1
              ? h(
                  'button',
                  { type: 'button', onClick: () => onStep?.(1), style: control },
                  '›',
                )
              : null,
            h('button', { type: 'button', onClick: () => onClose?.(), style: control }, t('detail.closeViewer')),
          ),
        ),
      )
    }

    /**
     * One text field over the settings form.
     *
     * Edits are held locally and committed on blur or Enter: committing each
     * keystroke would issue a write per character and fight the mirror refresh
     * for the caret.
     */
    function ConfigField({ label, hint, value, secret, placeholder, onCommit }) {
      const [draft, setDraft] = useState(value ?? '')
      const lastValue = useRef(value ?? '')

      useEffect(() => {
        // Adopt a value that changed underneath (for example after a failed write
        // was rolled back) without clobbering what the user is typing.
        if (value !== lastValue.current) {
          lastValue.current = value
          setDraft(value ?? '')
        }
      }, [value])

      const commit = () => {
        const next = String(draft ?? '')
        if (next === String(lastValue.current ?? '')) return
        lastValue.current = next
        onCommit(next)
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '10px 0',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
          },
        },
        h('label', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, label),
        h('input', {
          type: secret ? 'password' : 'text',
          value: draft,
          placeholder,
          style: {
            width: '100%',
            boxSizing: 'border-box',
            padding: '6px 8px',
            fontSize: 13,
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-layer-2)',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 6,
          },
          onChange: event => setDraft(event.target.value),
          onBlur: commit,
          onKeyDown: event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
              event.currentTarget.blur()
            }
          },
        }),
        hint ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, hint) : null,
      )
    }

    /** The configuration form: endpoint, API key, row count, identity override. */
    function ConfigSection({ configForm, t, onChanged }) {
      const snapshot = configForm.getSnapshot()
      const value = snapshot.value ?? {}
      const secretSet = (snapshot.secrets ?? []).some(secret => secret.path?.[0] === 'apiKey' && secret.set)

      const commit = useCallback((field, next) => {
        Promise.resolve(configForm.set(field, next)).then(
          () => onChanged?.(),
          () => onChanged?.(),
        )
      }, [configForm, onChanged])

      return h(
        'section',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h(
          'h3',
          { style: { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
          t('config.title'),
        ),
        h(
          'p',
          { style: { margin: '2px 0 6px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          t('config.note'),
        ),
        h(ConfigField, {
          label: t('config.endpoint'),
          value: value.endpoint ?? '',
          placeholder: 'https://yanfa.scedu.tech/api/mcp',
          onCommit: next => commit('endpoint', next),
        }),
        h(ConfigField, {
          label: t('config.apiKey'),
          value: value.apiKey ?? '',
          secret: true,
          placeholder: secretSet ? t('config.apiKeySet') : t('config.apiKeyHint'),
          hint: t('config.apiKeyNote'),
          onCommit: next => commit('apiKey', next),
        }),
        h(ConfigField, {
          label: t('config.pageSize'),
          value: String(value.pageSize ?? 15),
          hint: t('config.pageSizeNote'),
          onCommit: next => {
            const n = Math.floor(Number(next))
            commit('pageSize', Number.isFinite(n) && n > 0 ? Math.min(40, n) : 15)
          },
        }),
      )
    }

    /** A stand-in selector for a deployment that does not supply `useSessions`. */
    function useNoSessions() {
      return undefined
    }

    /**
     * Resolve this plugin's settings form.
     *
     * `describe()` keys namespaces by Loader entry id; the profile composes this
     * bundle's row as `include:<row id>`. The served directory is read first so a
     * differently composed id still resolves.
     */
    function useConfigForm(configForms) {
      const [namespace, setNamespace] = useState(CONFIG_NS)

      useEffect(() => {
        if (!configForms) return undefined
        const mirror = configForms.describe()
        const pick = () => {
          const served = (mirror.getSnapshot()?.view?.namespaces ?? []).map(view => view.ns)
          const found =
            served.find(ns => ns === CONFIG_NS)
            ?? served.find(ns => ns === CONFIG_ROW)
            ?? served.find(ns => ns.endsWith(`:${CONFIG_ROW}`))
          if (found !== undefined) setNamespace(found)
        }
        pick()
        mirror.ensure?.()
        return mirror.subscribe?.(pick)
      }, [configForms])

      return useMemo(
        () => (configForms === undefined ? undefined : configForms.get(namespace)),
        [configForms, namespace],
      )
    }

    /**
     * A searchable dropdown over a reference list.
     *
     * The input is the control: it shows the chosen value, and typing filters
     * the list. The list opens on focus and on typing, closes on Escape or on
     * a click elsewhere, and the arrow keys move through it.
     *
     * The server caps one page at 50 rows, so a keyword reaches the rest:
     * typing asks the server, and clearing it brings the loaded page back.
     *
     * `inline` puts the label next to the box instead of above it, for the
     * places where the field shares a row with other controls.
     */
    function RefSelect({ label, required, placeholder, options, loading, selected, onSearch, onPick, inline, t }) {
      const [keyword, setKeyword] = useState('')
      const [open, setOpen] = useState(false)
      const [active, setActive] = useState(0)
      /** The list opens upward when the space below the box is too small. */
      const [upward, setUpward] = useState(false)
      /** The input box, so the list can measure the room around it. */
      const boxRef = useRef(null)

      const input = {
        boxSizing: 'border-box',
        width: '100%',
        padding: '6px 8px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
      }
      // The loaded page, filtered locally, until the server answers.
      const list = Array.isArray(options) ? options : []
      const needle = String(keyword ?? '').trim().toLowerCase()
      const visible = needle === ''
        ? list
        : list.filter(option => option.label.toLowerCase().includes(needle))
      const chosen = list.find(option => option.value === selected)

      /** Choose one option and close the list. */
      const choose = option => {
        if (!option) return
        onPick?.(option.value)
        setKeyword('')
        setOpen(false)
      }

      /**
       * Open the list, away from the edge it would run into.
       *
       * The picker sits at the bottom of a ticket row, inside a box that
       * clips its overflow: a list that opens downward is cut off there. So
       * the side with more room wins.
       */
      const show = () => {
        const rect = boxRef.current?.getBoundingClientRect?.()
        if (rect && typeof window !== 'undefined') {
          const below = window.innerHeight - rect.bottom
          const above = rect.top
          setUpward(below < 240 && above > below)
        }
        setOpen(true)
      }

      const onKeyDown = event => {
        if (event.key === 'Escape') {
          setOpen(false)
          return
        }
        if (!open) {
          if (event.key === 'ArrowDown' || event.key === 'Enter') {
            show()
            setActive(0)
          }
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActive(current => Math.min(current + 1, visible.length - 1))
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActive(current => Math.max(current - 1, 0))
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          choose(visible[active])
        }
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            // Inline puts the label next to the box, in one row.
            flexDirection: inline ? 'row' : 'column',
            gap: inline ? 6 : 4,
            alignItems: inline ? 'center' : undefined,
            width: '100%',
            minWidth: 0,
          },
        },
        h(
          'label',
          {
            style: {
              fontSize: 12,
              color: 'var(--dsw-alias-label-secondary)',
              flexShrink: 0,
              whiteSpace: 'nowrap',
            },
          },
          required ? `${label} *` : label,
        ),
        // The list hangs from the box, not from the whole field, so it lines
        // up with the input even when the label stands beside it.
        h(
          'div',
          {
            style: {
              position: 'relative',
              width: inline ? undefined : '100%',
              flex: inline ? '1 1 auto' : undefined,
              minWidth: 0,
            },
          },
          h('input', {
            type: 'text',
            ref: boxRef,
            value: open ? keyword : (chosen?.label ?? ''),
            placeholder: placeholder,
            style: input,
            autoComplete: 'off',
            role: 'combobox',
            'aria-expanded': open,
            onFocus: show,
            onClick: show,
            onKeyDown: onKeyDown,
            onBlur: () => {
              // Let a click on an option land before the list closes.
              setTimeout(() => setOpen(false), 120)
            },
            onChange: event => {
              const value = event.target.value
              setKeyword(value)
              setOpen(true)
              setActive(0)
              onSearch?.(value)
            },
          }),
          open
            ? h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    // The list grows away from the edge it would run into.
                    ...(upward
                      ? { bottom: '100%', marginBottom: 2 }
                      : { top: '100%', marginTop: 2 }),
                    left: 0,
                    right: 0,
                    zIndex: 10,
                    maxHeight: 220,
                    overflowY: 'auto',
                    padding: 2,
                    borderRadius: 6,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-bg-layer-1)',
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.16)',
                  },
                },
                loading && visible.length === 0
                  ? h('div', { style: { padding: '6px 8px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('create.loading'))
                  : null,
                visible.length === 0 && !loading
                  ? h('div', { style: { padding: '6px 8px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('create.noMatch'))
                  : null,
                visible.map((option, index) =>
                  h(
                    'div',
                    {
                      key: option.value,
                      role: 'option',
                      'aria-selected': option.value === selected,
                      onMouseDown: event => {
                        // Mouse down beats blur, so the choice is not lost.
                        event.preventDefault()
                        choose(option)
                      },
                      onMouseEnter: () => setActive(index),
                      style: {
                        padding: '6px 8px',
                        fontSize: 13,
                        borderRadius: 4,
                        cursor: 'pointer',
                        color: 'var(--dsw-alias-label-primary)',
                        background: index === active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                      },
                    },
                    option.label,
                  )),
              )
            : null,
        ),
      )
    }

    /**
     * The 新建工单 form.
     *
     * It mirrors the gongsi form: a title, the issue type, the school, the
     * involved system and its version, the urgency, and the problem
     * description. The reference lists arrive from the Host half, which keeps
     * the API key in the browser out of the picture.
     */
    function CreateTicketSection({ t, onMeta, onCreate, onUpload, onCreated }) {
      const [types, setTypes] = useState(null)
      const [schools, setSchools] = useState([])
      const [products, setProducts] = useState([])
      const [versions, setVersions] = useState([])
      const [loadingSchools, setLoadingSchools] = useState(true)
      const [loadingProducts, setLoadingProducts] = useState(true)
      const [loadingVersions, setLoadingVersions] = useState(false)

      const [title, setTitle] = useState('')
      const [issueType, setIssueType] = useState('')
      const [schoolId, setSchoolId] = useState('')
      const [productId, setProductId] = useState('')
      const [productVersionId, setProductVersionId] = useState('')
      const [priority, setPriority] = useState('normal')
      const [description, setDescription] = useState('')
      /** The images picked for the description, as data URLs. */
      const [images, setImages] = useState([])

      const [pending, setPending] = useState(false)
      const [feedback, setFeedback] = useState(null)

      // The reference lists are loaded once: the schools and the products
      // arrive as one page each, and the dropdown filters them. Typing in a
      // filter asks the server for the rows past that page.
      useEffect(() => {
        let cancelled = false
        onMeta('schools').then(
          result => { if (!cancelled) { setSchools(result?.schools ?? []); setLoadingSchools(false) } },
          () => { if (!cancelled) { setSchools([]); setLoadingSchools(false) } },
        )
        onMeta('products').then(
          result => { if (!cancelled) { setProducts(result?.products ?? []); setLoadingProducts(false) } },
          () => { if (!cancelled) { setProducts([]); setLoadingProducts(false) } },
        )
        onMeta('issueTypes').then(
          result => { if (!cancelled) setTypes(result?.types ?? []) },
          () => { if (!cancelled) setTypes([]) },
        )
        return () => { cancelled = true }
      }, [onMeta])

      // The versions belong to the chosen product, so they follow it.
      useEffect(() => {
        if (productId === '') {
          setVersions([])
          setProductVersionId('')
          return undefined
        }
        let cancelled = false
        setLoadingVersions(true)
        onMeta('versions', '', productId).then(
          result => {
            if (cancelled) return
            setLoadingVersions(false)
            setVersions(result?.versions ?? [])
          },
          () => {
            if (cancelled) return
            setLoadingVersions(false)
            setVersions([])
          },
        )
        return () => { cancelled = true }
      }, [onMeta, productId])

      const input = {
        boxSizing: 'border-box',
        width: '100%',
        padding: '6px 8px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
      }
      const button = {
        fontSize: 12,
        padding: '5px 12px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      }
      const primary = {
        ...button,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-text-on-brand-primary, #fff)',
      }

      const typeOptions = (Array.isArray(types) ? types : []).map(type => ({ value: type.code, label: type.name }))
      const schoolOptions = schools.map(school => ({ value: String(school.id), label: school.name }))
      const productOptions = products.map(product => ({ value: String(product.id), label: product.name }))
      const versionOptions = versions.map(version => ({ value: String(version.id), label: version.version }))

      /** Read the images out of a paste and add them to the ticket. */
      const addImages = files => {
        if (files.length === 0) return
        Promise.all(files.map(file =>
          readImage(file).then(
            base64 => ({
              name: file.name || 'pasted-image.png',
              type: file.type || 'image/png',
              base64,
              url: URL.createObjectURL(file),
            }),
            error => ({
              name: file.name || 'pasted-image.png',
              type: file.type || 'image/png',
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        )).then(picked => {
          const failed = picked.filter(item => item.error)
          const ok = picked.filter(item => !item.error)
          setImages(previous => [...previous, ...ok])
          if (failed.length > 0) {
            setFeedback({
              ok: false,
              message: `${t('create.imageFailed')}: ${failed.map(item => `${item.name} (${item.error})`).join('; ')}`,
            })
          }
        })
      }

      const missing = []
      if (title.trim() === '') missing.push(t('create.title'))
      if (issueType === '') missing.push(t('create.issueType'))
      if (schoolId === '') missing.push(t('create.school'))
      if (productId === '') missing.push(t('create.product'))
      if (description.trim() === '') missing.push(t('create.description'))

      const submit = () => {
        if (missing.length > 0) return
        setPending(true)
        setFeedback(null)
        const request = {
          title: title.trim(),
          description: description.trim(),
          issueType,
          schoolId: Number(schoolId),
          productId: Number(productId),
          priority,
        }
        if (productVersionId !== '') request.productVersionId = Number(productVersionId)
        // The ticket has to exist before an image can be attached to it, so
        // the upload follows the creation.
        onCreate(request).then(
          result => {
            const action = result?.action ?? {}
            if (action.ok === false) {
              setPending(false)
              setFeedback({ ok: false, message: action.message ?? '' })
              return
            }
            const ticketNo = action.ticketNo ?? ''
            const ticketId = Number(action.ticketId) || 0
            if (images.length === 0 || ticketId <= 0) {
              finish(action, ticketNo, [])
              return
            }
            setFeedback({ ok: true, message: `${action.message ?? ''} (${t('create.uploading')})` })
            // Upload every image; one failure must not hide the others.
            Promise.all(images.map(image =>
              onUpload({
                ticketId,
                ticketNo,
                fileName: image.name,
                mimeType: image.type,
                fileBase64: image.base64,
              }).then(
                () => ({ ok: true }),
                error => ({ ok: false, name: image.name, message: error instanceof Error ? error.message : String(error) }),
              ),
            )).then(results => {
              const failed = results.filter(result => !result.ok)
              finish(action, ticketNo, failed)
            })
          },
          error => {
            setPending(false)
            setFeedback({ ok: false, message: error instanceof Error ? error.message : String(error) })
          },
        )
      }

      /** Report the outcome and clear the form. */
      const finish = (action, ticketNo, failed) => {
        setPending(false)
        setTitle('')
        setIssueType('')
        setSchoolId('')
        setProductId('')
        setProductVersionId('')
        setPriority('normal')
        setDescription('')
        setImages([])
        if (failed.length > 0) {
          setFeedback({
            ok: false,
            message: `${t('create.uploadFailed')}: ${failed.map(item => `${item.name} (${item.message})`).join('; ')}`,
          })
          return
        }
        setFeedback({ ok: true, message: action.message ?? ticketNo })
        onCreated?.(action)
      }

      const field = (label, required, control) =>
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h(
            'label',
            { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            required ? `${label} *` : label,
          ),
          control,
        )

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(
          'div',
          { style: { fontSize: 13, fontWeight: 600 } },
          t('create.title2'),
        ),
        field(t('create.title'), true, h('input', {
          type: 'text',
          value: title,
          maxLength: 200,
          placeholder: t('create.titlePlaceholder'),
          style: input,
          onChange: event => setTitle(event.target.value),
        })),
        field(t('create.issueType'), true, h(
          'select',
          {
            value: issueType,
            style: input,
            disabled: types === null,
            onChange: event => setIssueType(event.target.value),
          },
          h('option', { value: '' }, types === null ? t('create.loading') : t('create.choose')),
          typeOptions.map(option => h('option', { key: option.value, value: option.value }, option.label)),
        )),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
          h(RefSelect, {
            label: t('create.school'),
            required: true,
            placeholder: t('create.schoolSearch'),
            options: schoolOptions,
            loading: loadingSchools,
            selected: schoolId,
            onSearch: keyword => {
              setLoadingSchools(true)
              onMeta('schools', keyword).then(
                result => { setLoadingSchools(false); setSchools(result?.schools ?? []) },
                () => { setLoadingSchools(false) },
              )
            },
            onPick: setSchoolId,
            t,
          }),
          h(RefSelect, {
            label: t('create.product'),
            required: true,
            placeholder: t('create.productSearch'),
            options: productOptions,
            loading: loadingProducts,
            selected: productId,
            onSearch: keyword => {
              setLoadingProducts(true)
              onMeta('products', keyword).then(
                result => { setLoadingProducts(false); setProducts(result?.products ?? []) },
                () => { setLoadingProducts(false) },
              )
            },
            onPick: value => {
              setProductId(value)
              setProductVersionId('')
            },
            t,
          }),
        ),
        field(t('create.version'), false, h(
          'select',
          {
            value: productVersionId,
            style: input,
            disabled: productId === '' || loadingVersions || versionOptions.length === 0,
            onChange: event => setProductVersionId(event.target.value),
          },
          h(
            'option',
            { value: '' },
            productId === ''
              ? t('create.versionFirst')
              : (loadingVersions ? t('create.loading') : t('create.versionNone')),
          ),
          versionOptions.map(option => h('option', { key: option.value, value: option.value }, option.label)),
        )),
        field(t('create.priority'), false, h(
          'div',
          { style: { display: 'flex', gap: 6 } },
          ['high', 'medium', 'normal'].map(value =>
            h(
              'button',
              {
                type: 'button',
                onClick: () => setPriority(value),
                style: {
                  ...button,
                  border: `1px solid ${priority === value ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
                  background: priority === value ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
                  color: priority === value ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-primary)',
                },
              },
              t(`create.priority.${value}`),
            )),
        )),
        field(t('create.description'), true, h('textarea', {
          value: description,
          rows: 8,
          placeholder: t('create.descriptionPlaceholder'),
          style: { ...input, resize: 'vertical' },
          onChange: event => setDescription(event.target.value),
          // A pasted screenshot becomes an attachment right away.
          onPaste: event => {
            const files = pastedImages(event)
            if (files.length === 0) return
            event.preventDefault()
            addImages(files)
          },
        })),
        // Screenshots: the ticket has to exist before an image can be attached
        // to it, so they are uploaded right after the creation.
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h(
            'label',
            { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            t('create.images'),
          ),
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('create.imagesHint')),
          h('input', {
            type: 'file',
            accept: 'image/*',
            multiple: true,
            style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' },
            onChange: event => {
              const files = Array.from(event.target?.files ?? [])
              addImages(files)
              event.target.value = ''
            },
          }),
          images.length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
                images.map((image, index) =>
                  h(
                    'div',
                    {
                      key: `${image.name}-${index}`,
                      style: {
                        position: 'relative',
                        width: 72,
                        height: 72,
                        borderRadius: 6,
                        overflow: 'hidden',
                        border: '1px solid var(--dsw-alias-border-l1)',
                        background: 'var(--dsw-alias-bg-layer-2)',
                      },
                    },
                    h('img', {
                      src: image.url,
                      alt: image.name,
                      style: { width: '100%', height: '100%', objectFit: 'cover' },
                    }),
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => setImages(previous => previous.filter((_, at) => at !== index)),
                        style: {
                          position: 'absolute',
                          top: 2,
                          right: 2,
                          width: 18,
                          height: 18,
                          lineHeight: '16px',
                          fontSize: 11,
                          textAlign: 'center',
                          padding: 0,
                          borderRadius: 999,
                          border: '1px solid var(--dsw-alias-border-l1)',
                          background: 'var(--dsw-alias-bg-layer-1)',
                          color: 'var(--dsw-alias-label-primary)',
                          cursor: 'pointer',
                        },
                      },
                      '×',
                    ),
                  )),
              )
            : null,
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h(
            'button',
            {
              type: 'button',
              disabled: pending || missing.length > 0,
              onClick: submit,
              style: { ...primary, opacity: missing.length > 0 ? 0.5 : 1 },
            },
            pending ? t('create.submitting') : t('create.submit'),
          ),
          missing.length > 0
            ? h(
                'span',
                { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                t('create.missing').replace('{list}', missing.join('、')),
              )
            : null,
          feedback
            ? h(
                'span',
                {
                  style: {
                    fontSize: 12,
                    color: feedback.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
                  },
                },
                feedback.message
                  ? `${feedback.ok ? t('create.done') : t('create.failed')}: ${feedback.message}`
                  : (feedback.ok ? t('create.done') : t('create.failed')),
              )
            : null,
        ),
      )
    }

    /**
     * The page control under the ticket list.
     *
     * It offers the first, previous, next, and last page, and the numbers around
     * the current one, so a long list stays navigable without a huge strip.
     */
    function Pager({ t, page, pages, total, pageSize, onGo }) {
      const button = (label, target, disabled) => h(
        'button',
        {
          type: 'button',
          disabled,
          onClick: () => { if (!disabled) onGo(target) },
          style: {
            minWidth: 28,
            padding: '3px 8px',
            fontSize: 12,
            borderRadius: 6,
            border: `1px solid ${disabled ? 'var(--dsw-alias-border-l1)' : 'var(--dsw-alias-border-l1)'}`,
            background: 'var(--dsw-alias-bg-layer-1)',
            color: disabled ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
          },
        },
        label,
      )

      // The numbers to show: the current page plus its neighbours.
      const numbers = []
      const from = Math.max(1, page - 2)
      const to = Math.min(pages, page + 2)
      if (from > 1) numbers.push(1)
      if (from > 2) numbers.push('…')
      for (let n = from; n <= to; n += 1) numbers.push(n)
      if (to < pages - 1) numbers.push('…')
      if (to < pages) numbers.push(pages)

      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
            fontSize: 12,
            color: 'var(--dsw-alias-label-secondary)',
          },
        },
        h('span', null, t('pager.summary')
          .replace('{page}', String(page))
          .replace('{pages}', String(pages))
          .replace('{total}', String(total))
          .replace('{size}', String(pageSize))),
        h('span', { style: { flex: 1 } }),
        button('«', 1, page <= 1),
        button('‹', page - 1, page <= 1),
        numbers.map(number =>
          number === '…'
            ? h('span', { key: `gap-${number}-${page}`, style: { padding: '0 2px' } }, '…')
            : h(
                'button',
                {
                  key: number,
                  type: 'button',
                  onClick: () => onGo(number),
                  style: {
                    minWidth: 28,
                    padding: '3px 8px',
                    fontSize: 12,
                    borderRadius: 6,
                    border: `1px solid ${number === page ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
                    background: number === page ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
                    color: number === page ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-primary)',
                    cursor: 'pointer',
                  },
                },
                String(number),
              )),
        button('›', page + 1, page >= pages),
        button('»', pages, page >= pages),
      )
    }

    /**
     * The filter bar above the ticket list.
     *
     * The keyword, the status, and the issue type are applied by the server;
     * the priority, the school, and the creator narrow the rows the server
     * returned.
     */
    function FilterBar({ t, filters, options, onChange, onReset }) {
      const input = {
        boxSizing: 'border-box',
        width: '100%',
        padding: '5px 8px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
      }
      const field = (label, control) =>
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
          h('label', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, label),
          control,
        )
      const select = (value, onPick, placeholder, entries) =>
        h(
          'select',
          { value, style: input, onChange: event => onPick(event.target.value) },
          h('option', { value: '' }, placeholder),
          entries.map(entry =>
            h('option', { key: entry.value, value: entry.value }, entry.label)),
        )

      const statusEntries = STATUS_FILTERS.map(status => ({
        value: status.value,
        label: t(`filter.status.${status.value}`),
      }))
      const typeEntries = options.issueTypes.map(type => ({ value: type.code, label: type.name }))
      const priorityEntries = options.priorities.map(value => ({
        value,
        label: t(`filter.priority.${value}`),
      }))
      const schoolEntries = options.schools.map(name => ({ value: name, label: name }))
      const initiatorEntries = options.initiators.map(name => ({ value: name, label: name }))

      return h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
            gap: 8,
            alignItems: 'end',
          },
        },
        field(t('filter.keyword'), h('input', {
          type: 'search',
          value: filters.keyword,
          placeholder: t('filter.keywordPlaceholder'),
          style: input,
          onChange: event => onChange('keyword', event.target.value),
        })),
        field(t('filter.status'), select(filters.ticketStatus, value => onChange('ticketStatus', value), t('filter.all'), statusEntries)),
        field(t('filter.issueType'), select(filters.issueType, value => onChange('issueType', value), t('filter.all'), typeEntries)),
        field(t('filter.priority'), select(filters.priority, value => onChange('priority', value), t('filter.all'), priorityEntries)),
        field(t('filter.school'), select(filters.school, value => onChange('school', value), t('filter.all'), schoolEntries)),
        field(t('filter.initiator'), select(filters.initiator, value => onChange('initiator', value), t('filter.all'), initiatorEntries)),
        h(
          'button',
          {
            type: 'button',
            onClick: onReset,
            style: {
              fontSize: 12,
              padding: '5px 10px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)',
              color: 'var(--dsw-alias-label-primary)',
              cursor: 'pointer',
            },
          },
          t('filter.reset'),
        ),
      )
    }

    /** The panel body. */
    function TicketsPanel(props) {
      const { t, loadTickets, loadDetail } = props
      const [tab, setTab] = useState('all')
      /** The drilled-in ticket: `{ ticketNo, status, row, data, error }` or null. */
      const [detail, setDetail] = useState(null)
      const [cache, setCache] = useState({ all: null, mine: null })
      const [state, setState] = useState({ status: 'loading', error: null })
      /** Which write form each row currently shows, keyed by ticket number. */
      const [rowModes, setRowModes] = useState({})
      /**
       * Whether each row's ticket already carries a root-cause entry.
       *
       * `ready` unlocks 确认完成, `missing` is what the server said when a
       * completion was refused — the row then sends the user to 原因分析
       * instead. A ticket the panel has not heard about stays `undefined`,
       * so the link works and the server stays the judge.
       */
      const [rootCauseStates, setRootCauseStates] = useState({})
      /**
       * The list filters.
       *
       * The server filters by keyword, status, and issue type; the priority,
       * the school, and the creator are not server-side, so the panel narrows
       * those itself on the rows it holds.
       */
      const [filters, setFilters] = useState({
        keyword: '',
        ticketStatus: '',
        issueType: '',
        priority: '',
        school: '',
        initiator: '',
      })
      /** The issue types the filter bar offers; the server keeps the list. */
      const [issueTypes, setIssueTypes] = useState([])
      /** Which tab and server-side filter the cached list belongs to. */
      const [loadedKey, setLoadedKey] = useState('')
      /** Which page of the list is on screen, 1-based. */
      const [page, setPage] = useState(1)
      /** The ticket number whose quote is being prepared, while it loads. */
      const [quoting, setQuoting] = useState(null)
      /** What went wrong with the last quote, if anything. */
      const [quoteError, setQuoteError] = useState(null)
      /**
       * Every ticket the account can see.
       *
       * The filter bar needs the whole set: the school and the creator lists
       * must not be limited to the page that happens to be on screen.
       */
      const [allTickets, setAllTickets] = useState(null)

      const configForm = useConfigForm(props.configForms)

      /**
       * The console the share links point at.
       *
       * It comes from the configured endpoint, so the links always lead to
       * the console of the deployment this panel talks to.
       */
      const consoleUrl = consoleBase(configForm)

      /**
       * The Session the shell shows, or one that is still usable.
       *
       * The command Remote is agent scoped, so the ticket list needs a Session
       * to address. The shell reports retention per Session; the row with a
       * retained view is the one on screen. Archiving that row clears the
       * retention — and picking nothing then would leave the panel unable to
       * refresh, so a still-live Session is used instead, newest first.
       */
      const useSessions = props.useSessions ?? useNoSessions
      const sessionId = useSessions(snapshot => {
        const byId = snapshot?.byId ?? {}
        const ids = Array.isArray(snapshot?.ids) ? snapshot.ids : Object.keys(byId)
        // An archived or removed Session has no agent to address any more.
        const rows = ids
          .map(id => ({ id, row: byId[id] }))
          .filter(entry => entry.row && entry.row.archived !== true && entry.row.removed !== true)
        if (rows.length === 0) return undefined

        /** Is this row the one the shell is showing? */
        const isShown = row => {
          const counts = row.retainedBy ?? row.retainInfo?.retainedBy ?? row.retain?.retainedBy
          if (!counts || typeof counts !== 'object') return false
          return Object.values(counts).some(count => typeof count === 'number' && count > 0)
        }
        const shown = rows.find(entry => isShown(entry.row))
        if (shown) return shown.id

        /** Order by recency, whatever the row calls it. */
        const stamp = row => {
          const raw = row.updatedAt ?? row.updatedAtMs ?? row.lastActivityAt ?? row.createdAt ?? 0
          return typeof raw === 'number' ? raw : (Date.parse(raw) || 0)
        }
        const newest = [...rows].sort((left, right) => stamp(right.row) - stamp(left.row))[0]
        return newest?.id
      })

      /**
       * The filters the server applies.
       *
       * Keyword, status, and issue type are server-side; the rest are narrowed
       * here, on the rows the server returned.
       */
      const serverFilters = useMemo(() => {
        const out = {}
        const keyword = filters.keyword.trim()
        if (keyword) out.keyword = keyword
        if (filters.ticketStatus) out.ticketStatus = filters.ticketStatus
        if (filters.issueType) out.issueType = filters.issueType
        return out
      }, [filters.keyword, filters.ticketStatus, filters.issueType])

      const load = useCallback(async (which, force, wanted) => {
        // The configuration tab owns no ticket data: its form writes through the
        // settings service, so there is nothing to fetch for it. The create tab
        // fetches its own reference data on demand.
        if (which === 'config' || which === 'create') return
        if (!sessionId) {
          setState({ status: 'no-session', error: null })
          return
        }
        const wantedPage = Math.max(1, Math.floor(Number(wanted ?? page)) || 1)
        // A server-side filter change, or a page change, invalidates the cache.
        const key = `${which}|${wantedPage}|${JSON.stringify(serverFilters)}`
        if (!force && cache[which] !== null && loadedKey === key) return
        setState({ status: 'loading', error: null })
        try {
          const data = await loadTickets(sessionId, which, { ...serverFilters, page: wantedPage })
          setCache(previous => ({ ...previous, [which]: data }))
          setLoadedKey(key)
          setPage(wantedPage)
          setState({ status: data.tickets.length === 0 ? 'empty' : 'ready', error: null })
        } catch (error) {
          setState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
        }
      }, [cache, loadTickets, loadedKey, page, serverFilters, sessionId])

      // A new tab, or a new filter, starts again from the first page.
      useEffect(() => {
        setPage(1)
      }, [tab, serverFilters, filters.priority, filters.school, filters.initiator])

      // Load the active tab whenever the Session, the tab, or the page changes.
      useEffect(() => {
        void load(tab, false, page)
      }, [tab, page, load])

      // The issue types only change when the server's dictionary does.
      useEffect(() => {
        if (!sessionId || issueTypes.length > 0) return
        let cancelled = false
        props.meta(sessionId, 'issueTypes').then(
          result => { if (!cancelled) setIssueTypes(result?.types ?? []) },
          () => { if (!cancelled) setIssueTypes([]) },
        )
        return () => { cancelled = true }
      }, [issueTypes.length, props, sessionId])

      // Scan every page once, so the school and the creator filters cover the
      // whole set rather than the page on screen. The server-side filters ride
      // along, so a keyword and a school narrow the same universe.
      useEffect(() => {
        if (!sessionId) return undefined
        let cancelled = false
        props.act(sessionId, { op: 'allTickets', ...serverFilters }).then(
          result => { if (!cancelled) setAllTickets(result?.tickets ?? []) },
          () => { if (!cancelled) setAllTickets([]) },
        )
        return () => { cancelled = true }
      }, [props, serverFilters, sessionId])

      /** Whether any filter is narrowing the list. */
      const filterActive = Boolean(
        filters.keyword || filters.ticketStatus || filters.issueType
        || filters.priority || filters.school || filters.initiator,
      )

      /** Change one filter. */
      const setFilter = useCallback((key, value) => {
        setFilters(current => ({ ...current, [key]: value }))
      }, [])

      /** Clear every filter. */
      const resetFilters = useCallback(() => {
        setFilters({
          keyword: '',
          ticketStatus: '',
          issueType: '',
          priority: '',
          school: '',
          initiator: '',
        })
      }, [])

      /** Drill into one ticket's read-only detail. */
      const openDetail = useCallback(ticket => {
        setDetail({ ticketNo: ticket.ticketNo, status: 'loading', row: ticket, data: null, error: null, token: 0 })
      }, [])

      /** Run one write action against the drilled-in ticket. */
      const runAction = useCallback((request) => {
        if (!sessionId) return Promise.reject(new Error(t('status.noSession')))
        return props.act(sessionId, request)
      }, [sessionId, props, t])

      /** Attach one file to a ticket. */
      const uploadAttachment = useCallback((request) => {
        if (!sessionId) return Promise.reject(new Error(t('status.noSession')))
        return props.act(sessionId, { op: 'attachment', ...request })
      }, [sessionId, props, t])

      /** The user directory for the assign picker, narrowed by keyword. */
      const loadUsers = useCallback(keyword => {
        if (!sessionId) return Promise.resolve([])
        return props.listUsers(sessionId, keyword ?? '')
      }, [sessionId, props])

      /**
       * Carry one ticket into a fresh conversation.
       *
       * Only the ticket number goes into the draft: the new Session reads the
       * ticket itself through the gongsi tools, so it stays linked to the real
       * record instead of a copy. No detail read is needed here.
       *
       * `startSession()` with no Workspace opens in the one on screen, which is
       * the one the user is looking at while reading the ticket.
       */
      const quoteTicket = useCallback(async ticket => {
        setQuoteError(null)
        setQuoting(ticket.ticketNo)
        try {
          props.quote(quotePrompt(ticket))
        } catch (error) {
          setQuoteError(error instanceof Error ? error.message : String(error))
        } finally {
          setQuoting(null)
        }
      }, [props, t])

      /**
       * A write landed: drop the cached lists and refetch the detail.
       *
       * The `token` bump re-runs the detail effect for the same ticket.
       */
      const handleWritten = useCallback(() => {
        setCache({ all: null, mine: null })
        setDetail(previous => (previous ? { ...previous, token: (previous.token ?? 0) + 1 } : previous))
      }, [])

      // Fetch the drilled-in ticket's detail; the ticket number is the dep, so
      // status updates inside one drill-in never retrigger the fetch.
      useEffect(() => {
        if (detail === null) return
        if (!sessionId) {
          setDetail(previous => (previous ? { ...previous, status: 'error', error: t('status.noSession') } : previous))
          return
        }
        let cancelled = false
        loadDetail(sessionId, detail.ticketNo).then(
          data => {
            if (!cancelled) {
              setDetail(previous => (previous ? { ...previous, status: 'ready', data, error: null } : previous))
            }
          },
          error => {
            if (!cancelled) {
              const message = error instanceof Error ? error.message : String(error)
              setDetail(previous => (previous ? { ...previous, status: 'error', error: message } : previous))
            }
          },
        )
        return () => { cancelled = true }
      }, [detail === null ? null : detail.ticketNo, detail === null ? null : detail.token, sessionId, loadDetail, t])

      const active = cache[tab]
      const me = cache.mine?.me ?? cache.all?.me

      /**
       * The rows on screen, and the pagination around them.
       *
       * With no client-side filter the server already returned exactly one
       * page, so its rows are shown as they came. Once the school, the creator,
       * or the priority narrows the list, the rows come from the whole set and
       * are sliced here — otherwise picking a school whose tickets sit on a
       * later page would show nothing.
       */
      const view = useMemo(() => {
        const priority = filters.priority
        const school = filters.school
        const initiator = filters.initiator
        const clientSide = Boolean(priority || school || initiator)
        const pageSize = active?.pageSize ?? 15

        if (!clientSide) {
          const rows = active?.tickets ?? []
          return {
            rows,
            total: active?.total ?? rows.length,
            page: active?.page ?? 1,
            pages: active?.pages ?? 1,
            pageSize,
            clientSide: false,
          }
        }

        // The full set is only known once the scan finished.
        const source = allTickets !== null ? allTickets : (active?.tickets ?? [])
        let rows = source.filter(ticket => {
          if (priority && ticket.priority !== priority) return false
          if (school && ticket.schoolName !== school) return false
          if (initiator && ticket.initiatorName !== initiator) return false
          return true
        })
        // Keep the "mine" marking of the tab: the scan carries no owner flag.
        if (tab === 'mine') {
          const myId = me?.userId ?? 0
          if (myId > 0) rows = rows.filter(ticket => ticket.ownerUserId === myId)
        }
        const total = rows.length
        const pages = Math.max(1, Math.ceil(total / pageSize))
        const current = Math.min(page, pages)
        return {
          rows: rows.slice((current - 1) * pageSize, current * pageSize),
          total,
          page: current,
          pages,
          pageSize,
          clientSide: true,
        }
      }, [active, allTickets, filters.priority, filters.school, filters.initiator, me, page, tab])

      /** The rows on screen. */
      const tickets = view.rows

      /**
       * Which rows already earned their 确认完成 link.
       *
       * 确认完成 only appears once the ticket carries a root-cause entry, so
       * the panel asks once per list — and only about the rows of mine that
       * are being worked on, the only ones the closing steps apply to. The
       * answer is keyed by ticket number; a row the panel has not heard about
       * is left alone until the answer arrives.
       */
      const rootCauseKey = view.rows
        .filter(ticket => ticket.mine === true && ticket.status === 'processing')
        .map(ticket => `${ticket.ticketNo}:${ticket.taskId ?? ''}`)
        .join(',')
      useEffect(() => {
        if (!sessionId || rootCauseKey === '') return undefined
        let cancelled = false
        const items = rootCauseKey.split(',').map(part => {
          const [ticketNo, taskId] = part.split(':')
          return { ticketNo, taskId: Number(taskId) || undefined }
        })
        props.act(sessionId, { op: 'rootCauseStates', items }).then(
          result => {
            if (cancelled) return
            const flags = result?.flags ?? {}
            setRootCauseStates(current => {
              const next = { ...current }
              for (const item of items) {
                next[item.ticketNo] = flags[item.ticketNo] === true ? 'ready' : 'missing'
              }
              return next
            })
          },
          () => {
            // A failed read must not hide the way to close a ticket: the
            // server stays the judge.
            if (cancelled) return
            setRootCauseStates(current => {
              const next = { ...current }
              for (const item of items) next[item.ticketNo] = 'unknown'
              return next
            })
          },
        )
        return () => { cancelled = true }
      }, [props, sessionId, rootCauseKey])

      /**
       * The distinct values the client-side filters offer.
       *
       * The school and the creator lists cover every ticket the account can
       * see, not only the page on screen: the whole set is scanned once, in
       * the background, and the options come from there.
       */
      const filterOptions = useMemo(() => {
        const rows = allTickets ?? active?.tickets ?? []
        const collect = field => {
          const seen = new Set()
          for (const ticket of rows) {
            const value = ticket[field]
            if (value) seen.add(value)
          }
          return [...seen].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
        }
        return {
          schools: collect('schoolName'),
          initiators: collect('initiatorName'),
          priorities: ['high', 'medium', 'normal'],
          issueTypes,
          /** True while the full set is still being fetched. */
          scanning: allTickets === null,
          covered: allTickets?.length ?? 0,
        }
      }, [active, allTickets, issueTypes])

      /** A data tab's total row count, once that tab has been fetched. */
      const countOf = which => {
        const data = cache[which]
        return data ? data.total : null
      }

      /** One tab button; `count` is the badge, omitted when not applicable. */
      const tabButton = (id, label, count) => {
        const selected = tab === id
        return h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': selected,
            onClick: () => setTab(id),
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 12px',
              fontSize: 12,
              cursor: 'pointer',
              borderRadius: 6,
              border: `1px solid ${selected ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
              background: selected ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              color: selected ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
            },
          },
          label,
          count == null
            ? null
            : h(
                'span',
                { style: { fontSize: 11, opacity: 0.75 } },
                String(count),
              ),
        )
      }

      /** Fetch-related notices belong to the data tabs only. */
      const notice = tab === 'config' || tab === 'create'
        ? null
        : {
            loading: t('status.loading'),
            empty: tab === 'mine' ? t('status.emptyMine') : t('status.empty'),
            'no-session': t('status.noSession'),
          }[state.status]

      const panelStyle = {
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: 20,
        height: '100%',
        // The panel itself does not scroll: the header block stays put and only
        // the area below it moves.
        overflow: 'hidden',
        boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      }
      /**
       * The part of the panel that scrolls.
       *
       * `minHeight: 0` is what lets a flex child shrink below its content
       * size, so this box can scroll instead of pushing the header out of the
       * panel.
       */
      const scrollStyle = {
        flex: '1 1 auto',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        overflowY: 'auto',
        overflowX: 'hidden',
      }
      /** The header block: it never scrolls away. */
      const fixedStyle = {
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }
      const errorStyle = {
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 12,
        whiteSpace: 'pre-wrap',
      }

      /** The console link of the ticket that is open, when it has one. */
      const detailLink = detail === null ? '' : ticketLink(consoleUrl, detail.row)

      // The drilled-in ticket replaces the tabbed lists until dismissed.
      if (detail !== null) {
        return h(
          'div',
          { style: panelStyle },
          h(
            'header',
            { style: { display: 'flex', alignItems: 'center', gap: 10, flex: '0 0 auto' } },
            h(
              'button',
              {
                type: 'button',
                onClick: () => setDetail(null),
                style: {
                  fontSize: 12,
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  color: 'var(--dsw-alias-label-primary)',
                  cursor: 'pointer',
                },
              },
              `← ${t('detail.back')}`,
            ),
            h('span', { style: { flex: 1 } }),
            // Share: the link of the ticket that is open.
            detailLink
              ? h(ShareButton, {
                  url: detailLink,
                  t,
                  style: {
                    fontSize: 12,
                    padding: '4px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-bg-layer-1)',
                    color: 'var(--dsw-alias-label-primary)',
                    cursor: 'pointer',
                  },
                })
              : null,
            detail.status === 'loading'
              ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('status.loading'))
              : null,
          ),
          h(
            'div',
            { style: scrollStyle },
            detail.status === 'error' ? h('div', { style: errorStyle }, detail.error) : null,
            detail.status === 'ready' && detail.data
              ? h(TicketDetailView, {
                  detail: detail.data,
                  row: detail.row,
                  t,
                  onAct: runAction,
                  onWritten: handleWritten,
                })
              : null,
            detail.status === 'ready' && !detail.data
              ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('detail.unavailable'))
              : null,
          ),
        )
      }

      return h(
        'div',
        { style: panelStyle },
        h(
          'div',
          { style: fixedStyle },
          h(
            'header',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h(TicketsPanelIcon, { size: 20 }),
            h('h1', { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, t('title')),
            me?.name
              ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, me.name)
              : null,
            h('span', { style: { flex: 1 } }),
            tab === 'config' || tab === 'create'
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => void load(tab, true),
                    disabled: state.status === 'loading',
                    style: {
                      fontSize: 12,
                      padding: '4px 10px',
                      borderRadius: 6,
                      border: '1px solid var(--dsw-alias-border-l1)',
                      background: 'var(--dsw-alias-bg-layer-1)',
                      color: 'var(--dsw-alias-label-primary)',
                      cursor: state.status === 'loading' ? 'default' : 'pointer',
                    },
                  },
                  state.status === 'loading' ? t('action.loading') : t('action.refresh'),
                ),
          ),
          h(
            'div',
            { role: 'tablist', style: { display: 'flex', gap: 8, alignItems: 'center' } },
            tabButton('all', t('tab.all'), countOf('all')),
            tabButton('mine', t('tab.mine'), countOf('mine')),
            tabButton('create', t('tab.create')),
            tabButton('config', t('tab.config')),
            active && tab === 'all' && active.total > 0
              ? h(
                  'span',
                  { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginLeft: 'auto' } },
                  t('status.total').replace('{n}', String(active.total)),              )
              : null,
          ),
          tab !== 'config' && tab !== 'create'
            ? h(FilterBar, {
                t,
                filters,
                options: filterOptions,
                onChange: setFilter,
                onReset: resetFilters,
              })
            : null,
        ),
        h(
          'div',
          { style: scrollStyle },
          tab !== 'config' && tab !== 'create' && state.status === 'error'
            ? h('div', { style: errorStyle }, state.error)
            : null,
          quoteError
            ? h('div', { style: errorStyle }, quoteError)
            : null,
          filterOptions.scanning && tab !== 'config' && tab !== 'create'
            ? h(
                'div',
                { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                t('filter.scanning'),
              )
            : null,
          notice
            ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, notice)
            : null,
          tab === 'mine' && active && active.me?.userId === 0
            ? h(
                'div',
                { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } },
                t('status.noIdentity'),
              )
            : null,
          tickets.length > 0 && tab !== 'create' && tab !== 'config'
            ? h(
                'ul',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    margin: 0,
                    padding: 0,
                    listStyle: 'none',
                  },
                },
                tickets.map(ticket => h(TicketRow, {
                  key: ticket.ticketNo,
                  ticket,
                  t,
                  consoleUrl,
                  onOpen: openDetail,
                  onAct: runAction,
                  onUpload: uploadAttachment,
                  onQuote: quoteTicket,
                  quoting,
                  onUsers: loadUsers,
                  onWritten: handleWritten,
                  rowMode: rowModes[ticket.ticketNo] ?? null,
                  rootCauseReady: rootCauseStates[ticket.ticketNo],
                  onRootCauseState: state => setRootCauseStates(current => ({ ...current, [ticket.ticketNo]: state })),
                  onRowMode: mode => setRowModes(current => {
                    const next = { ...current }
                    if (mode === null || next[ticket.ticketNo] === mode) delete next[ticket.ticketNo]
                    else next[ticket.ticketNo] = mode
                    return next
                  }),
                  onDone: () => handleWritten(),
                })),
              )
            : null,
          tab !== 'config' && tab !== 'create' && view.pages > 1
            ? h(Pager, {
                t,
                page: view.page,
                pages: view.pages,
                total: view.total,
                pageSize: view.pageSize,
                onGo: next => setPage(next),
              })
            : null,
          tab !== 'config' && tab !== 'create' && view.pages <= 1 && filterActive
            ? h(
                'div',
                { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                t('filter.showing')
                  .replace('{n}', String(view.total))
                  .replace('{total}', String(filterOptions.covered)),
              )
            : null,
          tab === 'create'
            ? h(CreateTicketSection, {
                t,
                onMeta: (kind, keyword, productId) => {
                  if (!sessionId) return Promise.resolve({})
                  return props.meta(sessionId, kind, keyword, productId)
                },
                onCreate: request => {
                  if (!sessionId) return Promise.reject(new Error(t('status.noSession')))
                  return props.act(sessionId, { op: 'create', ...request })
                },
                onUpload: request => {
                  if (!sessionId) return Promise.reject(new Error(t('status.noSession')))
                  return props.act(sessionId, { op: 'attachment', ...request })
                },
                onCreated: () => {
                  // The new ticket belongs in both lists; refetch them so the
                  // ticket shows up where it should.
                  setCache({ all: null, mine: null })
                },
              })
            : null,
          tab === 'config'
            ? (configForm
                ? h(ConfigSection, {
                    configForm,
                    t,
                    // One written field invalidates both data tabs; switching to
                    // them (or the effect, while one is active) refetches.
                    onChanged: () => setCache({ all: null, mine: null }),
                  })
                : h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('config.unavailable')))
            : null,
        ),
      )
    }

    /**
     * Required browser services. `slots` registers the contributions, `locale`
     * supplies the dictionaries, and `remote.commands` is the bridge the panel
     * reads the ticket list through.
     */
    const inject = ['slots', 'locale', 'remote', 'remote.commands']

    /** Client entry. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, {
        zh: {
          'title': '工单',
          'panel': '工单',
          'tab.all': '全部工单',
          'tab.mine': '我的工单',
          'tab.create': '新建工单',
          'tab.config': '配置',
          'detail.back': '返回列表',
          'detail.initiator': '发起人',
          'detail.assignees': '协办人',
          'detail.issueType': '问题类型',
          'detail.school': '学校/项目',
          'detail.product': '涉及系统',
          'detail.createdAt': '创建时间',
          'detail.dueTime': '截止时间',
          'detail.worklogs': '工时汇总',
          'detail.personDays': ' 人天',
          'detail.aiStatus': 'AI 分析',
          'detail.description': '问题描述',
          'detail.feedback': '处理结论',
          'detail.attachments': '附件',
          'detail.logs': '处理记录',
          'detail.none': '无',
          'detail.viewImage': '点击放大查看',
          'detail.closeViewer': '关闭',
          'detail.unavailable': '未获取到该工单的详情。',
          'detail.logType.ai': 'AI 分析',
          'detail.logType.issue': '问题记录',
          'detail.logType.progress': '处理进展',
          'actions.title': '操作',
          'actions.comment': '评论',
          'actions.commentPlaceholder': '填写处理说明，输入 @ 可提及某人；可直接粘贴截图。',
          'actions.commentSubmit': '提交',
          'actions.worklog': '工时',
          'actions.workDate': '日期',
          'actions.hours': '小时',
          'actions.worklogHours': '小时数',
          'actions.worklogRemark': '工作内容备注',
          'actions.worklogSubmit': '提交',
          'actions.remarkPlaceholder': '工作内容备注（可留空）',
          'actions.overtime': '加班',
          'actions.assign': '指派处理人',
          'actions.assignNote': '指派后原处理人自动转为协办。',
          'actions.assignSubmit': '指派',
          'actions.usersPlaceholder': '选择处理人',
          'actions.usersSearch': '搜索姓名',
          'actions.usersNone': '没有匹配的人员。',
          'actions.usersLoading': '正在加载人员…',
          'actions.submit': '提交',
          'actions.submitting': '提交中…',
          'actions.done': '已提交',
          'actions.failed': '提交失败',
          'actions.imageFailed': '图片处理失败',
          'actions.uploadFailed': '部分图片上传失败',
          'actions.uploadingImages': '正在上传图片…',
          'badge.mine': '我的',
          'badge.unassigned': '未分派',
          'owner': '处理人',
          'initiator': '发起人',
          'filter.keyword': '关键字',
          'filter.keywordPlaceholder': '标题/工单号/描述',
          'filter.status': '状态',
          'filter.issueType': '问题类型',
          'filter.priority': '优先级',
          'filter.school': '学校',
          'filter.initiator': '创建人',
          'filter.all': '全部',
          'filter.reset': '重置',
          'filter.scanning': '正在统计全部工单…',
          'filter.showing': '当前显示 {n} 条，全部共 {total} 条',
          'pager.summary': '第 {page}/{pages} 页，共 {total} 条（每页 {size} 条）',
          'filter.status.created': '新建',
          'filter.status.assigned': '待处理',
          'filter.status.processing': '处理中',
          'filter.status.pending_review': '待确认',
          'filter.status.completed': '已完成',
          'filter.status.cancelled': '已取消',
          'filter.priority.high': '高',
          'filter.priority.medium': '中',
          'filter.priority.normal': '普通',
          'create.title2': '新建工单',
          'create.title': '标题',
          'create.titlePlaceholder': '一句话描述这个问题',
          'create.issueType': '问题类型',
          'create.school': '学校',
          'create.schoolSearch': '搜索学校',
          'create.product': '涉及系统',
          'create.productSearch': '搜索产品',
          'create.noMatch': '没有匹配项',
          'create.version': '版本',
          'create.versionFirst': '先选择涉及系统',
          'create.versionNone': '该系统没有版本',
          'create.priority': '紧急程度',
          'create.priority.high': '高',
          'create.priority.medium': '中',
          'create.priority.normal': '普通',
          'create.description': '问题描述',
          'create.descriptionPlaceholder': '描述现象、复现步骤、预期结果…',
          'create.images': '图片',
          'create.imagesHint': '可直接粘贴截图，或点击下方选择图片。',
          'create.uploading': '正在上传图片…',
          'create.imageFailed': '图片处理失败',
          'create.uploadFailed': '部分图片上传失败',
          'create.choose': '请选择',
          'create.loading': '加载中…',
          'create.submit': '提交',
          'create.submitting': '提交中…',
          'create.missing': '还需要填写：{list}',
          'create.done': '已创建',
          'create.failed': '创建失败',
          'row.assign': '分派',
          'row.share': '分享',
          'row.shareCopied': '已复制',
          'row.shareFailed': '复制失败',
          'row.shareHint': '复制这个工单在管理台的链接',
          'row.quote': '引用',
          'row.quoting': '引用中…',
          'row.quoteHint': '把这个工单带到新会话里继续分析',
          'quote.unavailable': '这个部署没有会话工作区，无法新开会话',
          'row.openDetail': '查看详情',
          'row.worklog': '工时',
          'row.comment': '评论',
          'row.start': '开始处理',
          'row.startConfirm': '确认开始',
          'row.complete': '确认完成',
          'row.completeConfirm': '提交完成',
          'row.rootCause': '原因分析',
          'row.rootCauseSave': '保存原因分析',
          'row.rootCauseReady': '原因分析已记录，可以直接确认完成。',
          'row.rootCausePlaceholder': '必填：现象 / 根因 / 影响范围 / 依据。保存后即可确认完成。',
          'row.cancel': '取消',
          'action.refresh': '刷新',
          'action.loading': '加载中…',
          'status.loading': '正在读取工单…',
          'status.empty': '没有查询到工单。',
          'status.emptyMine': '在可查询范围内没有你负责的工单。',
          'status.noSession': '没有可用的会话：工单查询要借用当前会话的 Agent。请新开或切换到一个会话再刷新（归档后的会话无法再用）。',
          'status.noIdentity': '未识别出当前用户：请确认 API Key 有效（「配置」栏目）。',
          'status.hostUnavailable': '工单命令 /gongsi-tickets 没有注册：插件的 Host 半没有加载。请在「插件」里确认它已启用；刚重启过 DSH 就刷新一下页面再试；刚装的包请重装一次（本包已自带依赖）。',
          'status.total': '共 {n} 条',
          'config.title': '接口配置',
          'config.note': '修改后点别处或按回车生效，切换回工单栏目时自动刷新。',
          'config.endpoint': 'MCP 接入地址',
          'config.apiKey': 'API Key',
          'config.apiKeySet': '已配置（留空则不修改）',
          'config.apiKeyHint': 'sk-…',
          'config.apiKeyNote': '密钥保存在 Host 端，页面不会回显。',
          'config.pageSize': '每页显示条数',
          'config.pageSizeNote': '1–40，默认 15。',
          'config.unavailable': '当前部署没有提供配置表单，请在插件设置中配置接入地址与密钥。',
        },
        en: {
          'title': 'Tickets',
          'panel': 'Tickets',
          'tab.all': 'All tickets',
          'tab.mine': 'My tickets',
          'tab.create': 'New ticket',
          'tab.config': 'Settings',
          'detail.back': 'Back to list',
          'detail.initiator': 'Initiator',
          'detail.assignees': 'Assignees',
          'detail.issueType': 'Issue type',
          'detail.school': 'School',
          'detail.product': 'Product',
          'detail.createdAt': 'Created',
          'detail.dueTime': 'Due',
          'detail.worklogs': 'Worklog summary',
          'detail.personDays': ' person-days',
          'detail.aiStatus': 'AI analysis',
          'detail.description': 'Description',
          'detail.feedback': 'Conclusion',
          'detail.attachments': 'Attachments',
          'detail.logs': 'Activity',
          'detail.none': 'None',
          'detail.viewImage': 'Click to enlarge',
          'detail.closeViewer': 'Close',
          'detail.unavailable': 'No detail was returned for this ticket.',
          'detail.logType.ai': 'AI analysis',
          'detail.logType.issue': 'Issue note',
          'detail.logType.progress': 'Progress',
          'actions.title': 'Actions',
          'actions.comment': 'Comment',
          'actions.commentPlaceholder': 'Write what was done; type @ to mention someone, and paste a screenshot straight in.',
          'actions.commentSubmit': 'Submit',
          'actions.worklog': 'Time',
          'actions.workDate': 'Date',
          'actions.hours': 'Hours',
          'actions.worklogHours': 'Hours',
          'actions.worklogRemark': 'What the work was',
          'actions.worklogSubmit': 'Submit',
          'actions.remarkPlaceholder': 'What the work was (optional)',
          'actions.overtime': 'Overtime',
          'actions.assign': 'Assign the owner',
          'actions.assignNote': 'The previous owner automatically becomes an associate.',
          'actions.assignSubmit': 'Assign',
          'actions.usersPlaceholder': 'Choose an owner',
          'actions.usersSearch': 'Search by name',
          'actions.usersNone': 'No matching people.',
          'actions.usersLoading': 'Loading people…',
          'actions.submit': 'Submit',
          'actions.submitting': 'Submitting…',
          'actions.done': 'Done',
          'actions.failed': 'Failed',
          'actions.imageFailed': 'Image failed',
          'actions.uploadFailed': 'Some images failed to upload',
          'actions.uploadingImages': 'Uploading images…',
          'badge.mine': 'Mine',
          'badge.unassigned': 'Unassigned',
          'owner': 'Owner',
          'initiator': 'Initiator',
          'filter.keyword': 'Keyword',
          'filter.keywordPlaceholder': 'Title / no. / description',
          'filter.status': 'Status',
          'filter.issueType': 'Issue type',
          'filter.priority': 'Priority',
          'filter.school': 'School',
          'filter.initiator': 'Created by',
          'filter.all': 'All',
          'filter.reset': 'Reset',
          'filter.scanning': 'Counting every ticket…',
          'filter.showing': 'Showing {n}, {total} in total',
          'pager.summary': 'Page {page}/{pages}, {total} tickets ({size} per page)',
          'filter.status.created': 'New',
          'filter.status.assigned': 'Assigned',
          'filter.status.processing': 'In progress',
          'filter.status.pending_review': 'To confirm',
          'filter.status.completed': 'Done',
          'filter.status.cancelled': 'Cancelled',
          'filter.priority.high': 'High',
          'filter.priority.medium': 'Medium',
          'filter.priority.normal': 'Normal',
          'create.title2': 'New ticket',
          'create.title': 'Title',
          'create.titlePlaceholder': 'One line about the problem',
          'create.issueType': 'Issue type',
          'create.school': 'School',
          'create.schoolSearch': 'Search schools',
          'create.product': 'Involved system',
          'create.productSearch': 'Search products',
          'create.noMatch': 'No match',
          'create.version': 'Version',
          'create.versionFirst': 'Pick the system first',
          'create.versionNone': 'This system has no versions',
          'create.priority': 'Urgency',
          'create.priority.high': 'High',
          'create.priority.medium': 'Medium',
          'create.priority.normal': 'Normal',
          'create.description': 'Description',
          'create.descriptionPlaceholder': 'What happened, how to reproduce it, the expected result…',
          'create.images': 'Images',
          'create.imagesHint': 'Paste a screenshot straight into the description, or pick a file below.',
          'create.uploading': 'Uploading images…',
          'create.imageFailed': 'Image failed',
          'create.uploadFailed': 'Some images failed to upload',
          'create.choose': 'Choose',
          'create.loading': 'Loading…',
          'create.submit': 'Submit',
          'create.submitting': 'Submitting…',
          'create.missing': 'Still needed: {list}',
          'create.done': 'Created',
          'create.failed': 'Failed',
          'row.assign': 'Assign',
          'row.share': 'Share',
          'row.shareCopied': 'Copied',
          'row.shareFailed': 'Copy failed',
          'row.shareHint': 'Copy the link to this ticket in the console',
          'row.quote': 'Quote',
          'row.quoting': 'Quoting…',
          'row.quoteHint': 'Carry this ticket into a new conversation and keep analysing there',
          'quote.unavailable': 'This deployment has no session workspace, so no new conversation can be opened',
          'row.openDetail': 'View the detail',
          'row.worklog': 'Time',
          'row.comment': 'Comment',
          'row.start': 'Start',
          'row.startConfirm': 'Start it',
          'row.complete': 'Complete',
          'row.completeConfirm': 'Complete it',
          'row.rootCause': 'Root cause',
          'row.rootCauseSave': 'Save the analysis',
          'row.rootCauseReady': 'The analysis is recorded — you can complete the ticket now.',
          'row.rootCausePlaceholder': 'Required: symptom / root cause / impact / evidence. Saving it unlocks 确认完成.',
          'row.cancel': 'Cancel',
          'action.refresh': 'Refresh',
          'action.loading': 'Loading…',
          'status.loading': 'Loading tickets…',
          'status.empty': 'No tickets were returned.',
          'status.emptyMine': 'None of the tickets you own fall in the searchable window.',
          'status.noSession': 'No session available: the ticket query borrows the current session\'s agent. Open or switch to a session and refresh (an archived session cannot be used).',
          'status.noIdentity': 'Your user id could not be detected; check that the API key is valid in Settings.',
          'status.hostUnavailable': 'The ticket command /gongsi-tickets is not registered: the plugin\'s Host half did not load. Check that the plugin is enabled; if DSH was just restarted, refresh the page and try again; if the package was just installed, install it again (this package vendors its dependencies).',
          'status.total': '{n} total',
          'config.title': 'Endpoint configuration',
          'config.note': 'Changes apply when you leave the field or press Enter; the ticket tabs refresh when you switch back to them.',
          'config.endpoint': 'MCP endpoint',
          'config.apiKey': 'API key',
          'config.apiKeySet': 'Configured (leave empty to keep it)',
          'config.apiKeyHint': 'sk-…',
          'config.apiKeyNote': 'The key is kept on the Host; this page never echoes it.',
          'config.pageSize': 'Rows per page',
          'config.pageSizeNote': '1–40, default 15.',
          'config.unavailable': 'This deployment has no configuration form; set the endpoint and key in the plugin settings.',
        },
      }), 'gongsi-tickets-panel: locale')

      const t = ctx.locale.bind(NS)

      /** Run one Host-half command line and return its parsed JSON payload. */
      const runCommand = async (sessionId, line) => {
        const response = await ctx.remote.commands.execute(sessionId, line, [])
        if (!response.ok) {
          throw new Error(`${response.error.code}: ${response.error.message}`)
        }
        if (response.value === undefined) {
          // The executor reports an unresolved command this way: the Host half
          // never registered it, which almost always means the Host half itself
          // failed to load (a missing dependency, or the plugin disabled).
          throw new Error(t('status.hostUnavailable'))
        }
        const result = response.value.result
        if (result.kind !== 'success') {
          throw new Error(result.text || 'gongsi tickets failed')
        }
        if (typeof result.text !== 'string') {
          throw new Error('gongsi tickets returned no payload')
        }
        return JSON.parse(result.text)
      }

      /**
       * The ticket list of one tab.
       *
       * The server-side filters travel as one JSON payload after the tab, so
       * the command stays a single line.
       */
      const loadTickets = async (sessionId, tab, filters) => {
        const head = tab === 'mine' ? `${TICKETS_COMMAND} mine` : `${TICKETS_COMMAND} all`
        const payload = filters && Object.keys(filters).length > 0 ? ` ${JSON.stringify(filters)}` : ''
        const line = `${head}${payload}`
        const parsed = await runCommand(sessionId, line)
        const tickets = Array.isArray(parsed?.tickets) ? parsed.tickets : []
        const total = typeof parsed?.total === 'number' ? parsed.total : tickets.length
        const pageSize = typeof parsed?.pageSize === 'number' && parsed.pageSize > 0 ? parsed.pageSize : 15
        return {
          me: parsed?.me ?? { userId: 0, name: '' },
          total,
          tickets,
          page: typeof parsed?.page === 'number' ? parsed.page : 1,
          pageSize,
          pages: typeof parsed?.pages === 'number' ? parsed.pages : Math.max(1, Math.ceil(total / pageSize)),
        }
      }

      /** One ticket's read-only detail. */
      const loadDetail = async (sessionId, ticketNo) => {
        const parsed = await runCommand(sessionId, `${TICKETS_COMMAND} detail ${ticketNo}`)
        return parsed?.detail ?? null
      }

      /**
       * Run one write action on a ticket.
       *
       * The payload travels as one JSON line so free-text content, the
       * idempotency key, and the numbers keep their shape.
       */
      const act = async (sessionId, request) => {
        return await runCommand(sessionId, `${TICKETS_COMMAND} act ${JSON.stringify(request)}`)
      }

      /** The user directory the assign picker offers. */
      const listUsers = async (sessionId, keyword) => {
        const parsed = await runCommand(
          sessionId,
          `${TICKETS_COMMAND} act ${JSON.stringify({ op: 'users', keyword: keyword ?? '' })}`,
        )
        return Array.isArray(parsed?.users) ? parsed.users : []
      }

      /**
       * The reference data the create form needs.
       *
       * `kind` picks the list; `keyword` narrows the schools and the products,
       * and `productId` asks for one product's versions.
       */
      const meta = async (sessionId, kind, keyword, productId) => {
        const request = { op: kind }
        if (keyword) request.keyword = keyword
        if (productId) request.productId = productId
        return await runCommand(sessionId, `${TICKETS_COMMAND} act ${JSON.stringify(request)}`)
      }

      // The settings form is optional: a deployment without the settings
      // service still renders the list, it just cannot edit the endpoint.
      //
      // It is read when the panel renders, not when this half applies. At a
      // cold start the settings service may not be up yet, and a value sampled
      // once would stay missing for the whole session — the config tab would
      // come up empty after every restart.
      const configForms = () => ctx.get('configForms')

      // Quoting a ticket opens a fresh Session and leaves a pointer to the
      // ticket in its draft box. The pointer is the ticket number, not a copy
      // of its text: the new Session reads the ticket through the gongsi tools
      // whenever it needs it, so the analysis always sees current data and the
      // conversation stays linked to the ticket it came from.
      //
      // The service is optional: a deployment without the workspace UI simply
      // has no quote button to press.
      const quote = (prompt) => {
        const uiWorkspace = ctx.get('uiWorkspace')
        if (!uiWorkspace || typeof uiWorkspace.startSession !== 'function') {
          throw new Error(t('quote.unavailable'))
        }
        // No Workspace is named: the shell opens the Session in the one on
        // screen, which is where the reader already is.
        uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'replace' })
      }

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({
          loadTickets,
          loadDetail,
          act,
          listUsers,
          meta,
          quote,
          // A getter, not a value: the service can arrive after this half
          // applied, and the panel must see it when it renders.
          get configForms() { return configForms() },
        }),
      }, TicketsPanel))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: () => t('panel'),
        locale: NS,
      }, TicketsPanelIcon))
    }

    return {
      inject,
      apply,
    }
  },
})
