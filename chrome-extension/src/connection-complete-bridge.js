const connectionCodePattern = /^[A-Z2-9]{5}-[A-Z2-9]{5}$/;

window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  const data = event.data;
  if (
    data?.source !== "web-to-figma-connect" ||
    data?.type !== "device-connection-approved" ||
    !connectionCodePattern.test(String(data.userCode || ""))
  ) {
    return;
  }

  void chrome.runtime.sendMessage({
    type: "WEB_TO_FIGMA_CLOUD_CONNECTION_APPROVED",
    userCode: data.userCode,
  });
});
