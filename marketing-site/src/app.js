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

})();
