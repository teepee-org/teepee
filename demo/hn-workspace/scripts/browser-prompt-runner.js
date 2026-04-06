(() => {
  const config = {
    topicName: 'hn-live-demo',
    createTopicIfMissing: true,
    delayMs: 1500,
    hotkey: 'F1',
    prompts: [
      '@coder @reviewer @architect introduce yourselves in one short sentence. Say only your role and what you do best.',
      '@reviewer review this workspace and give me 2 concrete findings with file references.',
      '@architect propose 1 small but worthwhile feature for this workspace, then turn it into a concrete task for "@coder".',
    ],
  };

  let running = false;

  async function fetchJson(url, options) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options && options.headers ? options.headers : {}),
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }

    return res.json();
  }

  async function resolveTopicId() {
    const topics = await fetchJson('/api/topics');
    const existing = topics.find((topic) => topic.name === config.topicName);
    if (existing) return existing.id;

    if (!config.createTopicIfMissing) {
      throw new Error(`Topic not found: ${config.topicName}`);
    }

    const created = await fetchJson('/api/topics', {
      method: 'POST',
      body: JSON.stringify({ name: config.topicName }),
    });
    return created.id;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function run() {
    if (running) {
      console.warn('[teepee-demo] already running');
      return;
    }

    running = true;
    const topicId = await resolveTopicId();
    try {
      console.log(`[teepee-demo] using topic ${topicId} (${config.topicName})`);

      for (const prompt of config.prompts) {
        const result = await fetchJson(`/api/topics/${topicId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ text: prompt }),
        });
        console.log(`[teepee-demo] sent message ${result.id}: ${prompt}`);
        await sleep(config.delayMs);
      }

      console.log('[teepee-demo] done');
    } finally {
      running = false;
    }
  }

  function onKeydown(event) {
    if (event.key !== config.hotkey) return;
    event.preventDefault();
    run().catch((error) => {
      console.error('[teepee-demo] failed', error);
    });
  }

  window.removeEventListener('keydown', window.__teepeeDemoHotkeyHandler);
  window.__teepeeDemoHotkeyHandler = onKeydown;
  window.addEventListener('keydown', onKeydown);

  console.log(
    `[teepee-demo] ready. Focus the Teepee page and press ${config.hotkey} to send ${config.prompts.length} prompts to topic "${config.topicName}".`
  );
  console.log('[teepee-demo] or run window.__teepeeDemoRun() from the console.');

  window.__teepeeDemoRun = () => {
    run().catch((error) => {
      console.error('[teepee-demo] failed', error);
    });
  };
  window.__teepeeDemoConfig = config;
})();
