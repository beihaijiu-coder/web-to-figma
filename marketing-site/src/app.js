(() => {
  const menuToggle = document.querySelector('.menu-toggle');
  const siteNavigation = document.querySelector('.site-nav');

  if (menuToggle && siteNavigation) {
    const closeMenu = () => {
      menuToggle.setAttribute('aria-expanded', 'false');
      siteNavigation.classList.remove('is-open');
    };

    menuToggle.addEventListener('click', () => {
      const expanded = menuToggle.getAttribute('aria-expanded') === 'true';
      menuToggle.setAttribute('aria-expanded', String(!expanded));
      siteNavigation.classList.toggle('is-open', !expanded);
    });

    siteNavigation.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenu();
    });
  }

  const billingButtons = [...document.querySelectorAll('[data-billing]')];
  const price = document.querySelector('[data-price]');
  const caption = document.querySelector('[data-price-caption]');

  const plans = {
    annual: { price: '$96', suffix: ' / 年', caption: '年付默认推荐；也可按月订阅。' },
    monthly: { price: '$12', suffix: ' / 月', caption: '月付与年付享有相同的 Pro 权益。' },
  };

  const selectBilling = (period) => {
    const selectedPlan = plans[period];
    if (!selectedPlan || !price || !caption) return;

    price.innerHTML = `<span>${selectedPlan.price}</span>${selectedPlan.suffix}`;
    caption.textContent = selectedPlan.caption;
    billingButtons.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.billing === period));
    });
  };

  billingButtons.forEach((button) => {
    button.addEventListener('click', () => selectBilling(button.dataset.billing));
  });
})();
