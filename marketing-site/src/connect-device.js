(() => {
  const configNode = document.getElementById('connect-config');
  const statusNode = document.getElementById('connectStatus');

  const config = JSON.parse(configNode?.textContent || '{}');
  const params = new URLSearchParams(window.location.search);
  const userCode = String(params.get('user_code') || '').trim().toUpperCase();

  function setStatus(message) {
    statusNode.textContent = message || '';
  }

  function notifyExtensionOfApproval() {
    window.postMessage(
      {
        source: 'web-to-figma-connect',
        type: 'device-connection-approved',
        userCode,
      },
      window.location.origin
    );
  }

  function normalizeApiBaseUrl(value) {
    const url = new URL(value || 'http://localhost:8787');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('API 地址必须以 http:// 或 https:// 开头。');
    }
    return url.origin;
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

  function hasUsableClerkConfig() {
    return /^pk_(test|live)_/.test(config.clerkPublishableKey || '');
  }

  function loadScript(src, attributes = {}) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.crossOrigin = 'anonymous';
      for (const [name, value] of Object.entries(attributes)) {
        script.setAttribute(name, value);
      }
      script.onload = resolve;
      script.onerror = () => reject(new Error(`无法加载脚本：${src}`));
      document.head.appendChild(script);
    });
  }

  async function approveAndReturnToClient() {
    setStatus('正在完成账号连接…');
    await submitDecision('approve');
    notifyExtensionOfApproval();
    setStatus('连接完成，正在回到原网页…');
  }

  async function initializeClerk() {
    if (!hasUsableClerkConfig() || config.clerkPublishableKey === 'pk_test_replace_me') {
      setStatus('等待配置 Clerk 前端密钥。');
      return null;
    }

    const frontendApiUrl =
      String(config.clerkFrontendApiUrl || '').trim() || deriveFrontendApiUrl(config.clerkPublishableKey);
    if (!frontendApiUrl) throw new Error('无法从 Clerk Publishable Key 推导 Frontend API URL。');

    await loadScript(`${frontendApiUrl}/npm/@clerk/ui@1/dist/ui.browser.js`);
    await loadScript(`${frontendApiUrl}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, {
      'data-clerk-publishable-key': config.clerkPublishableKey,
    });

    await window.Clerk.load({
      ui: { ClerkUI: window.__internal_ClerkUICtor },
    });

    if (window.Clerk.isSignedIn) {
      await approveAndReturnToClient();
      return window.Clerk;
    }

    const signIn = window.Clerk.client?.signIn;
    if (!signIn?.authenticateWithRedirect) {
      throw new Error('Google 登录暂时不可用，请稍后重试。');
    }

    setStatus('正在打开 Google 登录…');
    await signIn.authenticateWithRedirect({
      strategy: 'oauth_google',
      redirectUrl: window.location.href,
      redirectUrlComplete: window.location.href,
    });
    return null;
  }

  async function submitDecision(kind) {
    const clerk = window.Clerk;
    if (!clerk?.session) throw new Error('请先登录 Web to Figma。');
    const token = await clerk.session.getToken();
    if (!token) throw new Error('无法取得登录会话，请重新登录。');

    const endpoint = kind === 'approve' ? '/v1/device-connections/approve' : '/v1/device-connections/deny';
    const response = await fetch(`${normalizeApiBaseUrl(config.apiBaseUrl)}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userCode }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.error?.message || `请求失败：HTTP ${response.status}`);
    }
    return body;
  }

  if (!userCode) {
    setStatus('连接链接缺少 user_code，请从 Chrome 扩展或 Figma 插件重新发起连接。');
    return;
  }

  initializeClerk().catch((error) => {
    setStatus(error.message || String(error));
  });
})();
