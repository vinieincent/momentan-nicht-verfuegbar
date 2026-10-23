/* =====================================================
   app.js – Logik der Seite. Einstellungen stehen in config.js.
   ===================================================== */
(() => {
    const C = window.SITE;
    const START = new Date(C.START);
    const STATUS_URL = `https://api.mcstatus.io/v2/status/java/${C.SERVER_IP}`;
    const PAGE_SIZE = 24;
    const INGAME_RE = /^[A-Za-z0-9_]{3,16}$/;
    const REAL_NAME_RE = /^[\p{L}\p{M}0-9 .'’-]{2,40}$/u;

    const ERRORS = {
        invalid_name:    'Bitte gib deinen Namen an (2–40 Zeichen, keine Sonderzeichen).',
        invalid_ingame:  'Ingame-Name: 3–16 Zeichen, nur Buchstaben, Zahlen und _.',
        invalid_skill:   'Bitte wähle deinen Skill von 1 bis 5.',
        not_found:       'Diesen Minecraft-Account gibt es nicht. Prüfe die Schreibweise (Java Edition).',
        duplicate:       'Dieser Minecraft-Account ist schon angemeldet.',
        unavailable:     'Die Prüfung bei Mojang ist gerade nicht möglich. Bitte versuche es gleich nochmal.',
        busy:            'Gerade ist viel los. Bitte versuche es in einer Minute nochmal.',
        server_error:    'Etwas ist schiefgelaufen. Bitte versuche es später nochmal.',
        network:         'Keine Verbindung zum Anmelde-Server. Prüfe dein Internet und versuche es nochmal.'
    };

    const $ = id => document.getElementById(id);
    const pad2 = n => String(n).padStart(2, '0');
    const timeout = ms => AbortSignal.timeout(ms);

    function el(tag, className, text) {
        const e = document.createElement(tag);
        if (className) e.className = className;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    const skin = name => `https://mc-heads.net/avatar/${encodeURIComponent(name)}/72`;
    const profile = name => `https://namemc.com/profile/${encodeURIComponent(name)}`;

    async function getJson(params) {
        const response = await fetch(`${C.API_URL}?${new URLSearchParams(params)}`, { signal: timeout(15000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }

    /* ---------- Texte aus config.js einsetzen ---------- */
    const zone = { timeZone: 'Europe/Berlin' };
    const dateLong = new Intl.DateTimeFormat('de-DE', { ...zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(START);
    const dateShort = new Intl.DateTimeFormat('de-DE', { ...zone, day: 'numeric', month: 'long' }).format(START);
    const clock = new Intl.DateTimeFormat('de-DE', { ...zone, hour: '2-digit', minute: '2-digit' }).format(START);
    const whenShort = `${dateShort} um ${clock} Uhr`;

    document.querySelectorAll('[data-project]').forEach(n => n.textContent = C.PROJECT_NAME);
    document.querySelectorAll('[data-ip]').forEach(n => n.textContent = C.SERVER_IP);
    $('start-time').textContent = `${dateLong}, ${clock} Uhr`;
    $('start-time').dateTime = START.toISOString();
    $('start-short').textContent = whenShort;
    $('done-when').textContent = whenShort;
    $('home-link').href = C.HOME_URL;
    $('projects-link').href = C.PROJECTS_URL;
    document.title = `${C.PROJECT_NAME} – Start am ${whenShort}`;

    if (C.MODPACK_URL) {
        $('modpack').hidden = false;
        $('modpack-link').href = C.MODPACK_URL;
    }

    /* ---------- Hinweis (Toast) ---------- */
    let toastTimer;
    function toast(message) {
        const t = $('toast');
        t.textContent = message;
        t.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.hidden = true, 3500);
    }

    /* ---------- Countdown ---------- */
    function tick() {
        const left = START - Date.now();
        if (left <= 0) {
            document.body.dataset.phase = 'live';
            return;
        }
        document.body.dataset.phase = 'soon';
        $('cd-days').textContent    = pad2(Math.floor(left / 86400000));
        $('cd-hours').textContent   = pad2(Math.floor(left % 86400000 / 3600000));
        $('cd-minutes').textContent = pad2(Math.floor(left % 3600000 / 60000));
        $('cd-seconds').textContent = pad2(Math.floor(left % 60000 / 1000));
    }

    /* ---------- Server-IP kopieren ---------- */
    async function copyIp(button) {
        try {
            await navigator.clipboard.writeText(C.SERVER_IP);
        } catch {
            const ta = el('textarea');
            ta.value = C.SERVER_IP;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.append(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            if (!ok) return toast(`Bitte manuell kopieren: ${C.SERVER_IP}`);
        }
        toast(`IP kopiert: ${C.SERVER_IP}`);
        const original = button.textContent;
        button.textContent = 'Kopiert!';
        setTimeout(() => button.textContent = original, 1500);
    }

    document.querySelectorAll('[data-copy-ip]').forEach(b => b.addEventListener('click', () => copyIp(b)));

    /* ---------- Kalendereintrag (.ics) ---------- */
    $('btn-calendar').addEventListener('click', () => {
        const utc = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
        const end = new Date(START.getTime() + 60 * 60 * 1000);
        const ics = [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Scuffed Attack//DE', 'BEGIN:VEVENT',
            `UID:${utc(START)}@scuffed-attack`,
            `DTSTAMP:${utc(new Date())}`,
            `DTSTART:${utc(START)}`,
            `DTEND:${utc(end)}`,
            `SUMMARY:${C.PROJECT_NAME} startet`,
            `DESCRIPTION:Server-IP: ${C.SERVER_IP}`,
            'END:VEVENT', 'END:VCALENDAR'
        ].join('\r\n');

        const link = el('a');
        link.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
        link.download = 'scuffed-attack-3.ics';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });

    /* ---------- Serverstatus ---------- */
    const state = { onlineNames: new Set(), names: [], playersState: 'loading', showAll: false };

    function setStatus(kind, text) {
        $('status').dataset.state = kind;
        $('status-text').textContent = text;
    }

    async function refreshStatus() {
        try {
            const response = await fetch(STATUS_URL, { cache: 'no-store', signal: timeout(8000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();

            if (data.online) {
                setStatus('online', 'Server ist online');
                $('fact-version').textContent = data.version?.name_clean || data.version?.name_raw || '–';
                $('fact-players').textContent = `${data.players.online} / ${data.players.max}`;
            } else {
                setStatus(START > Date.now() ? 'waiting' : 'offline',
                          START > Date.now() ? `Noch offline, Start am ${whenShort}` : 'Server ist gerade offline');
                $('fact-version').textContent = '–';
                $('fact-players').textContent = '–';
            }

            const online = data.online ? (data.players?.list || []) : [];
            state.onlineNames = new Set(online.map(p => (p.name_clean || p.name_raw).toLowerCase()));
            renderOnline(online);
            renderPlayers();
        } catch (error) {
            console.error('[Status]', error);
            setStatus('error', 'Status gerade nicht abrufbar');
        }
    }

    function renderOnline(list) {
        $('online-now').hidden = list.length === 0;
        $('online-list').replaceChildren(...list.map(p => {
            const name = p.name_clean || p.name_raw;
            const li = el('li');
            const a = el('a', 'chip');
            a.href = profile(name);
            a.target = '_blank';
            a.rel = 'noopener';
            const img = el('img');
            img.src = skin(name);
            img.alt = '';
            img.loading = 'lazy';
            a.append(img, el('span', 'name', name));
            li.append(a);
            return li;
        }));
    }

    /* ---------- Angemeldete Spieler (nur Ingame-Namen) ---------- */
    async function loadPlayers() {
        if (!C.API_URL) {
            console.warn('[Spielerliste] API_URL in config.js ist noch leer.');
            state.playersState = 'unconfigured';
            return renderPlayers();
        }
        try {
            const data = await getJson({ action: 'list' });
            if (!data.ok) throw new Error(data.error);
            const seen = new Set();
            state.names = data.names.filter(n => INGAME_RE.test(n) && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
            state.playersState = 'ok';
        } catch (error) {
            console.error('[Spielerliste]', error);
            if (state.playersState !== 'ok') state.playersState = 'error';
        }
        renderPlayers();
    }

    function renderPlayers() {
        const box = $('players-state');
        const grid = $('player-grid');
        const more = $('btn-more');
        const query = $('player-search').value.trim().toLowerCase();

        box.className = 'state';
        box.replaceChildren();
        more.hidden = true;
        $('players-count').textContent = state.playersState === 'ok' ? `(${state.names.length})` : '';

        if (state.playersState !== 'ok') {
            grid.replaceChildren();
            if (state.playersState === 'loading') box.textContent = 'Lade Spieler …';
            else if (state.playersState === 'unconfigured') box.textContent = 'Die Spielerliste erscheint hier, sobald die Anmeldung läuft.';
            else {
                box.classList.add('is-error');
                box.append('Die Liste konnte nicht geladen werden. ');
                const retry = el('button', 'link-button', 'Erneut versuchen');
                retry.type = 'button';
                retry.addEventListener('click', () => { state.playersState = 'loading'; renderPlayers(); loadPlayers(); });
                box.append(retry);
            }
            return;
        }

        const matches = state.names.filter(n => n.toLowerCase().includes(query));
        const limited = !query && !state.showAll && matches.length > PAGE_SIZE;
        const shown = limited ? matches.slice(0, PAGE_SIZE) : matches;

        grid.replaceChildren(...shown.map(name => {
            const li = el('li');
            const a = el('a', 'player');
            a.href = profile(name);
            a.target = '_blank';
            a.rel = 'noopener';
            const img = el('img');
            img.src = skin(name);
            img.alt = '';
            img.loading = 'lazy';
            a.append(img, el('span', 'name', name));
            if (state.onlineNames.has(name.toLowerCase())) {
                const live = el('span', 'live');
                live.title = 'Gerade online';
                a.append(live, el('span', 'visually-hidden', ' (online)'));
            }
            li.append(a);
            return li;
        }));

        if (!matches.length) {
            box.textContent = state.names.length
                ? 'Kein Spieler mit diesem Namen gefunden.'
                : 'Noch niemand angemeldet. Sei der Erste!';
        }
        if (limited) {
            more.hidden = false;
            more.textContent = `Alle ${matches.length} anzeigen`;
        }
    }

    $('btn-more').addEventListener('click', () => { state.showAll = true; renderPlayers(); });
    $('player-search').addEventListener('input', renderPlayers);

    /* ---------- Anmeldeformular ---------- */
    const dialog = $('signup');
    const form = $('signup-form');
    const fIngame = $('f-ingame');
    const ingameStatus = $('ingame-status');
    const formError = $('form-error');
    const submitBtn = $('submit-btn');
    let submitting = false;
    let checkToken = 0;
    let checkTimer;
    let registered = null;

    function setIngameStatus(kind, text) {
        ingameStatus.dataset.kind = kind;
        ingameStatus.textContent = text;
    }

    function showError(message) {
        formError.textContent = message;
        formError.hidden = false;
    }

    // Live-Prüfung: Account vorhanden? Schon angemeldet? (die endgültige Prüfung macht immer der Server)
    async function checkIngame() {
        clearTimeout(checkTimer);
        const value = fIngame.value.trim();
        const token = ++checkToken;
        if (!value) return setIngameStatus('', '');
        if (!INGAME_RE.test(value)) return setIngameStatus('error', ERRORS.invalid_ingame);
        if (!C.API_URL) return;

        setIngameStatus('pending', 'Prüfe Minecraft-Account …');
        try {
            const data = await getJson({ action: 'check', name: value });
            if (token !== checkToken) return;
            setIngameStatus(data.ok ? 'ok' : 'error', data.ok ? `Account gefunden: ${data.name}` : (ERRORS[data.error] || ERRORS.server_error));
        } catch (error) {
            if (token === checkToken) setIngameStatus('error', ERRORS.network);
        }
    }

    fIngame.addEventListener('input', () => {
        formError.hidden = true;
        ++checkToken;
        setIngameStatus('', '');
        clearTimeout(checkTimer);
        checkTimer = setTimeout(checkIngame, 600);
    });
    fIngame.addEventListener('blur', checkIngame);

    function showDone(name) {
        registered = name;
        $('done-name').textContent = name;
        $('done-skin').src = skin(name);
        form.hidden = true;
        $('signup-done').hidden = false;
    }

    form.addEventListener('submit', async e => {
        e.preventDefault();
        if (submitting) return;
        formError.hidden = true;

        const name = form.elements.name.value.replace(/\s+/g, ' ').trim();
        const ingame = fIngame.value.trim();
        const skill = form.elements.skill.value;

        if (!REAL_NAME_RE.test(name))  { showError(ERRORS.invalid_name);   return form.elements.name.focus(); }
        if (!INGAME_RE.test(ingame))   { showError(ERRORS.invalid_ingame); return fIngame.focus(); }
        if (!skill)                    { return showError(ERRORS.invalid_skill); }

        submitting = true;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Wird geprüft und gesendet …';

        try {
            const response = await fetch(C.API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // einfache Anfrage, kein CORS-Preflight nötig
                body: JSON.stringify({ name, ingame, skill: Number(skill), website: form.elements.website.value }),
                signal: timeout(30000)
            });
            const data = await response.json();

            if (data.ok) {
                showDone(data.name || ingame);
                if (data.name && !state.names.some(n => n.toLowerCase() === data.name.toLowerCase())) {
                    state.names.push(data.name);
                    renderPlayers();
                }
                toast('Du bist angemeldet!');
                setTimeout(loadPlayers, 3000);
            } else {
                showError(ERRORS[data.error] || ERRORS.server_error);
                if (['not_found', 'duplicate', 'invalid_ingame'].includes(data.error)) {
                    setIngameStatus('error', ERRORS[data.error]);
                    fIngame.focus();
                }
            }
        } catch (error) {
            console.error('[Anmeldung]', error);
            showError(ERRORS.network);
        } finally {
            submitting = false;
            submitBtn.disabled = false;
            submitBtn.textContent = 'Anmelden';
        }
    });

    function openSignup() {
        if (!C.API_URL) {
            form.hidden = true;
            $('signup-unconfigured').hidden = false;
        }
        dialog.showModal();
        if (!registered && C.API_URL) form.elements.name.focus();
    }

    document.querySelectorAll('[data-open-signup]').forEach(b => b.addEventListener('click', openSignup));
    dialog.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });  // Klick auf den Hintergrund

    /* ---------- Start ---------- */
    tick();
    refreshStatus();
    loadPlayers();
    renderPlayers();

    setInterval(tick, 1000);
    setInterval(refreshStatus, 30000);
    setInterval(loadPlayers, 2 * 60 * 1000);
    $('btn-refresh').addEventListener('click', () => { setStatus('loading', 'Status wird geladen …'); refreshStatus(); });
})();
