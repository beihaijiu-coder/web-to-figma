(() => {
  const configNode = document.getElementById('account-config');
  const authMount = document.getElementById('authMount');
  const summary = document.getElementById('accountSummary');
  const statusNode = document.getElementById('accountStatus');
  const planValue = document.getElementById('planValue');
  const usedValue = document.getElementById('usedValue');
  const remainingValue = document.getElementById('remainingValue');
  const installationSection = document.getElementById('installationSection');
  const installationList = document.getElementById('installationList');
  const config = JSON.parse(configNode?.textContent || '{}');
  let renderedSessionId;

  function setStatus(message) {
    statusNode.textContent = message || '';
  }

  function deriveFrontendApiUrl(publishableKey) {
    const parts = String(publishableKey || '').split('_');
    if (parts.length < 3) return '';
    try {
      return `https://${atob(parts[2]).slice(0, -1)}`;
    } catch {
      return '';
    }
  }

  function loadScript(src, attributes = {}) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.crossOrigin = 'anonymous';
      Object.entries(attributes).forEach(([name, value]) => script.setAttribute(name, value));
      script.onload = resolve;
      script.onerror = () => reject(new Error(`无法加载登录组件：${src}`));
      document.head.appendChild(script);
    });
  }

  async function apiRequest(path, token, options = {}) {
    const apiUrl = new URL(config.apiBaseUrl || 'http://localhost:8787');
    const response = await fetch(`${apiUrl.origin}${path}`, {
      method: options.method || 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || `账号请求失败：HTTP ${response.status}`);
    return body;
  }

  async function loadInstallations(token) {
    const body = await apiRequest('/v1/me/installations', token);
    const installations = Array.isArray(body.installations) ? body.installations : [];
    installationList.replaceChildren();
    if (!installations.length) {
      const empty = document.createElement('p');
      empty.className = 'connect-note';
      empty.textContent = '还没有连接 Chrome 扩展或 Figma 插件。';
      installationList.append(empty);
    }

    installations.forEach((installation) => {
      const row = document.createElement('article');
      row.className = 'installation-row';
      const details = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = installation.displayName ||
        (installation.clientType === 'figma_plugin' ? 'Figma 插件' : 'Chrome 扩展');
      const meta = document.createElement('span');
      meta.textContent = installation.status === 'active' ? '已连接' : '已撤销';
      details.append(name, meta);
      row.append(details);

      if (installation.status === 'active') {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'button button-secondary button-small';
        revoke.textContent = '断开';
        revoke.addEventListener('click', async () => {
          revoke.disabled = true;
          setStatus('正在撤销客户端...');
          try {
            await apiRequest(`/v1/me/installations/${encodeURIComponent(installation.id)}`, token, {
              method: 'DELETE',
            });
            await loadInstallations(token);
            setStatus('客户端已撤销。');
          } catch (error) {
            revoke.disabled = false;
            setStatus(error.message || String(error));
          }
        });
        row.append(revoke);
      }
      installationList.append(row);
    });
    installationSection.hidden = false;
  }

  async function loadCurrentUser(clerk) {
    const token = await clerk.session?.getToken();
    if (!token) throw new Error('无法取得登录会话，请重新登录。');
    const body = await apiRequest('/v1/me', token);

    planValue.textContent = body.quota?.unlimited
      ? 'Pro'
      : body.entitlement?.plan === 'pro'
        ? 'Free（Pro 未生效）'
        : 'Free';
    usedValue.textContent = String(body.quota?.used ?? 0);
    remainingValue.textContent = body.quota?.remaining === null ? '无限' : String(body.quota?.remaining ?? 0);
    summary.hidden = false;
    await loadInstallations(token);
    setStatus('账号与权益已同步。');
  }

  async function renderAccount(clerk) {
    const sessionId = clerk.session?.id || null;
    if (renderedSessionId === sessionId) return;
    renderedSessionId = sessionId;
    authMount.replaceChildren();
    summary.hidden = true;
    installationSection.hidden = true;

    if (!clerk.isSignedIn || !clerk.session) {
      const signIn = document.createElement('div');
      signIn.id = 'signIn';
      authMount.append(signIn);
      clerk.mountSignIn(signIn);
      setStatus('请使用 Google 登录 Web to Figma。');
      return;
    }

    const userButton = document.createElement('div');
    userButton.id = 'userButton';
    authMount.append(userButton);
    clerk.mountUserButton(userButton);
    setStatus('正在读取账号权益...');
    await loadCurrentUser(clerk);
  }

  async function initialize() {
    const publishableKey = String(config.clerkPublishableKey || '');
    if (!/^pk_(test|live)_/.test(publishableKey) || publishableKey === 'pk_test_replace_me') {
      authMount.innerHTML = '<p class="connect-note">还没有配置 Clerk Publishable Key。填入本地环境变量后即可登录。</p>';
      setStatus('等待配置 Clerk 前端密钥。');
      return;
    }

    const frontendApiUrl =
      String(config.clerkFrontendApiUrl || '').trim() || deriveFrontendApiUrl(publishableKey);
    if (!frontendApiUrl) throw new Error('无法从 Clerk Publishable Key 推导 Frontend API URL。');
    await loadScript(`${frontendApiUrl}/npm/@clerk/ui@1/dist/ui.browser.js`);
    await loadScript(`${frontendApiUrl}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, {
      'data-clerk-publishable-key': publishableKey,
    });
    await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
    window.Clerk.addListener(() => renderAccount(window.Clerk).catch((error) => setStatus(error.message || String(error))));
    await renderAccount(window.Clerk);
  }

  initialize().catch((error) => setStatus(error.message || String(error)));
})();
