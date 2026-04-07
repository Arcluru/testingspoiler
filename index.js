// Discord Spoiler Tags Extension for SillyTavern
// Converts ||text|| into clickable spoiler blocks, like Discord.

(function () {
    'use strict';

    // ─── Constants ────────────────────────────────────────────────────────────

    const SPOILER_SOURCE  = '\\|\\|(.+?)\\|\\|';
    const SPOILER_FLAGS   = 'gs';
    const PROCESSED_ATTR  = 'data-ds-done';
    const MAX_RETRIES     = 20;

    // ─── Revealed-state registry ──────────────────────────────────────────────
    //
    // SillyTavern fully rewrites mesText.innerHTML on every streaming token,
    // destroying any spans we created the previous tick — including their
    // class lists.  We therefore CANNOT read revealed state from the DOM
    // inside applyStreamingSpoilers; those elements are already gone.
    //
    // Instead we maintain a module-level Set that is written at click time
    // (before ST touches anything) and read each time we recreate the spans.
    // Key = trimmed text content of the spoiler, which is stable for complete
    // ||...|| pairs.  The set is cleared when streaming ends so it doesn't
    // bleed into the next message.

    const revealedSpoilers = new Set();

    // ─── Interaction guard ────────────────────────────────────────────────────
    //
    // In Chromium-based browsers, if the element under mousedown is removed from
    // the DOM before mouseup fires, the browser cancels the click event entirely —
    // it never reaches our delegated listener.  Because ST replaces innerHTML on
    // every streaming token (potentially many times per second), the span the user
    // pressed on gets destroyed between mousedown and mouseup, silently swallowing
    // the click.
    //
    // We set this flag on mousedown (when the target is a spoiler) and clear it on
    // mouseup.  applyStreamingSpoilers checks it and skips the innerHTML replacement
    // while a click is in flight, keeping the span alive long enough for the browser
    // to fire the click event.  The very next streaming token after mouseup will
    // call applyStreamingSpoilers normally and restore revealed state from the Set.

    let userInteracting = false;

    // ─── Core: text-node walker ───────────────────────────────────────────────
    //
    // Used for final processing once a message is complete.
    // Walking text nodes avoids double-encoding, cross-tag matching,
    // and nuking revealed-state classes.

    function processMesText(mesText) {
        const textNodes = [];
        const walker = document.createTreeWalker(mesText, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (node.nodeValue.includes('||')) textNodes.push(node);
        }

        if (textNodes.length === 0) return false;

        textNodes.forEach(textNode => {
            const raw = textNode.nodeValue;
            const fragment = document.createDocumentFragment();
            let lastIndex = 0;
            let match;

            const re = new RegExp(SPOILER_SOURCE, SPOILER_FLAGS);

            while ((match = re.exec(raw)) !== null) {
                if (match.index > lastIndex) {
                    fragment.appendChild(
                        document.createTextNode(raw.slice(lastIndex, match.index))
                    );
                }

                const span = document.createElement('span');
                span.className = 'ds-spoiler';
                span.title = 'Click to reveal spoiler';
                span.setAttribute('aria-label', 'Spoiler — click to reveal');
                span.textContent = match[1];

                fragment.appendChild(span);
                lastIndex = match.index + match[0].length;
            }

            if (lastIndex < raw.length) {
                fragment.appendChild(document.createTextNode(raw.slice(lastIndex)));
            }

            textNode.parentNode.replaceChild(fragment, textNode);
        });

        return true;
    }

    // ─── Per-message processing (final, post-stream) ──────────────────────────

    function processMessage(mes) {
        if (mes.hasAttribute(PROCESSED_ATTR)) return;

        const mesText = mes.querySelector('.mes_text');
        if (!mesText) return;

        if (!mesText.textContent.includes('||')) return;

        const changed = processMesText(mesText);
        if (changed) mes.setAttribute(PROCESSED_ATTR, '1');
    }

    function processAllMessages() {
        document.querySelectorAll('#chat .mes').forEach(processMessage);
    }

    // ─── Streaming: MutationObserver approach ────────────────────────────────
    //
    // The MutationObserver fires on every streaming token that ST writes.
    // Two problems arise if we call applyStreamingSpoilers on every single fire:
    //
    //   1. FLICKER ON HOVER — CSS transitions begin on the span, but the span is
    //      immediately destroyed and recreated by the next innerHTML replacement,
    //      causing rapid visual flashing whenever the pointer is over a spoiler.
    //
    //   2. CLICKS DON'T REGISTER — Chromium cancels a click when the mousedown
    //      target is removed from the DOM before mouseup.  With replacements
    //      happening many times per second, the span is almost always gone by
    //      the time mouseup fires.
    //
    // Fix for (1): requestAnimationFrame throttle — no matter how many tokens
    // arrive in one frame, we only replace innerHTML once per ~16 ms, making
    // the span stable enough that CSS transitions can actually run.
    //
    // Fix for (2): userInteracting guard — when mousedown lands on a spoiler we
    // skip the replacement until mouseup, guaranteeing the span survives the
    // full click gesture.  The next token after mouseup does a normal replacement
    // and restores revealed state from revealedSpoilers.

    let streamObserver = null;
    let rafPending     = false;

    function applyStreamingSpoilers(mesText) {
        // Don't destroy the span the user is currently clicking on.
        if (userInteracting) return;

        if (!mesText.innerHTML.includes('||')) return;

        // Disconnect first so our own write doesn't re-trigger the observer.
        streamObserver.disconnect();

        mesText.innerHTML = mesText.innerHTML
            // Pass 1: complete pairs  ||...||
            .replace(
                /\|\|(.+?)\|\|/gs,
                '<span class="ds-spoiler" title="Click to reveal spoiler">$1</span>'
            )
            // Pass 2: unclosed opening || — hides everything after it while
            // the AI is still streaming.  Any || left here is guaranteed
            // unpaired because Pass 1 already consumed all complete pairs.
            .replace(
                /\|\|(.+)/gs,
                '<span class="ds-spoiler ds-spoiler--streaming" title="Click to reveal spoiler">$1</span>'
            );

        // Restore revealed state from our persistent registry.
        // We key on trimmed textContent, which is stable for complete pairs.
        if (revealedSpoilers.size > 0) {
            mesText.querySelectorAll('.ds-spoiler').forEach(el => {
                if (revealedSpoilers.has(el.textContent.trim())) {
                    el.classList.add('ds-spoiler--revealed');
                }
            });
        }

        // Reconnect to watch the next token.
        streamObserver.observe(mesText, { childList: true, subtree: true, characterData: true });
    }

    function startStreamObserver() {
        stopStreamObserver();

        const messages = document.querySelectorAll('#chat .mes');
        if (!messages.length) return;

        const last = messages[messages.length - 1];
        last.removeAttribute(PROCESSED_ATTR);

        const mesText = last.querySelector('.mes_text');
        if (!mesText) return;

        streamObserver = new MutationObserver(() => {
            // Throttle to one innerHTML replacement per animation frame.
            // This eliminates hover flicker and keeps the span stable long
            // enough for CSS transitions to render cleanly.
            if (rafPending) return;
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;
                applyStreamingSpoilers(mesText);
            });
        });

        streamObserver.observe(mesText, { childList: true, subtree: true, characterData: true });

        // Handle any spoilers already present when streaming starts.
        applyStreamingSpoilers(mesText);
    }

    function stopStreamObserver() {
        if (streamObserver) {
            streamObserver.disconnect();
            streamObserver = null;
        }
        rafPending = false;
        // Clear the registry so revealed state doesn't bleed into the next message.
        revealedSpoilers.clear();
    }

    // ─── Delegated click handler ──────────────────────────────────────────────
    //
    // Attached once to #chat (or document as fallback).  Catches clicks on
    // every .ds-spoiler regardless of when or how the span was created —
    // innerHTML streaming spans included — and survives innerHTML rewrites.
    //
    // mousedown/mouseup set the userInteracting guard described above.
    // The click handler is also the WRITE path for revealedSpoilers.

    function attachDelegatedClick() {
        const root = document.getElementById('chat') || document;

        // Set the guard the moment the pointer goes down on a spoiler.
        root.addEventListener('mousedown', function (e) {
            if (e.target.closest('.ds-spoiler')) {
                userInteracting = true;
            }
        });

        // Always clear the guard on mouseup, even if the pointer drifted off
        // the element — we want streaming to resume immediately after.
        root.addEventListener('mouseup', function () {
            userInteracting = false;
        });

        // Safety net: if mouseup fires outside #chat (e.g. user dragged out),
        // clear the flag there too so we don't block streaming indefinitely.
        document.addEventListener('mouseup', function () {
            userInteracting = false;
        });

        root.addEventListener('click', function (e) {
            const spoiler = e.target.closest('.ds-spoiler');
            if (!spoiler) return;

            spoiler.classList.toggle('ds-spoiler--revealed');
            const key = spoiler.textContent.trim();

            if (spoiler.classList.contains('ds-spoiler--revealed')) {
                revealedSpoilers.add(key);
            } else {
                revealedSpoilers.delete(key);
            }
        });
    }

    // ─── Event registration ───────────────────────────────────────────────────

    let retryCount = 0;

    function registerEvents() {
        const ctx = window.SillyTavern?.getContext?.();

        if (!ctx || !ctx.eventSource || !ctx.event_types) {
            if (++retryCount > MAX_RETRIES) {
                console.warn('[Discord Spoilers] Could not find SillyTavern context after ' +
                             MAX_RETRIES + ' attempts. Giving up.');
                return;
            }
            setTimeout(registerEvents, 500);
            return;
        }

        const { eventSource, event_types } = ctx;

        // Stream finished — stop observer, do the final clean DOM-safe pass.
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
            stopStreamObserver();
            setTimeout(processAllMessages, 50);
        });

        eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
            setTimeout(processAllMessages, 50);
        });

        // First streaming token — attach observer once, it stays until stream ends.
        if (event_types.STREAM_TOKEN_RECEIVED) {
            eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => {
                if (!streamObserver) startStreamObserver();
            });
        }

        if (event_types.MESSAGE_SWIPED) {
            eventSource.on(event_types.MESSAGE_SWIPED, () => {
                setTimeout(processAllMessages, 50);
            });
        }

        if (event_types.MESSAGE_EDITED) {
            eventSource.on(event_types.MESSAGE_EDITED, () => {
                document.querySelectorAll(`#chat .mes[${PROCESSED_ATTR}]`).forEach(mes => {
                    mes.removeAttribute(PROCESSED_ATTR);
                });
                setTimeout(processAllMessages, 50);
            });
        }

        eventSource.on(event_types.CHAT_CHANGED, () => {
            setTimeout(processAllMessages, 200);
        });

        console.log('[Discord Spoilers] Extension loaded and listening.');
    }

    // ─── Entry point ──────────────────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            attachDelegatedClick();
            registerEvents();
        });
    } else {
        attachDelegatedClick();
        registerEvents();
    }

    setTimeout(processAllMessages, 1000);

})();
