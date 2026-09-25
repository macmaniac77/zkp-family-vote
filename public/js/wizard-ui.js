/**
 * Shared wizard chrome: progress bar, role banner, flash, nav shell.
 */

import { bindHelpButtons, helpButton } from './help.js';

export function wizardNav(active = 'home') {
  const links = [
    { id: 'home', href: '/', label: 'Start' },
    { id: 'voter', href: '/voter.html', label: 'Voter wizard' },
    { id: 'admin', href: '/admin.html', label: 'Organizer' },
    { id: 'results', href: '/results.html', label: 'Results' },
  ];
  return `
    <nav class="top wizard-nav">
      <a class="brand" href="/">Family Vote</a>
      <div class="links">
        ${links
          .map(
            (l) =>
              `<a href="${l.href}" class="${l.id === active ? 'nav-active' : ''}">${l.label}</a>`
          )
          .join('')}
      </div>
    </nav>`;
}

/**
 * @param {{steps: string[], current: number, title?: string}} opts
 * current is 0-based index
 */
export function renderProgress({ steps, current, title }) {
  const pct = steps.length <= 1 ? 100 : Math.round((current / (steps.length - 1)) * 100);
  return `
    <div class="wiz-progress card">
      ${title ? `<div class="wiz-progress-title">${title}</div>` : ''}
      <div class="wiz-track"><div class="wiz-track-fill" style="width:${pct}%"></div></div>
      <ol class="wiz-steps">
        ${steps
          .map((label, i) => {
            let cls = 'wiz-step';
            if (i < current) cls += ' done';
            if (i === current) cls += ' current';
            return `<li class="${cls}"><span class="wiz-num">${i < current ? '✓' : i + 1}</span><span class="wiz-label">${label}</span></li>`;
          })
          .join('')}
      </ol>
    </div>`;
}

export function roleBanner({ who, doing, next, helpId }) {
  return `
    <div class="role-banner card">
      <div class="role-grid">
        <div>
          <div class="role-kicker">Who you are ${helpId ? helpButton(helpId) : ''}</div>
          <div class="role-val">${who}</div>
        </div>
        <div>
          <div class="role-kicker">What you’re doing</div>
          <div class="role-val">${doing}</div>
        </div>
        <div>
          <div class="role-kicker">Where this goes next</div>
          <div class="role-val">${next}</div>
        </div>
      </div>
    </div>`;
}

export function stepHeader(title, helpId) {
  return `<h2 class="step-h">${title}${helpId ? ' ' + helpButton(helpId) : ''}</h2>`;
}

export function flashEl(el, text, kind = 'info') {
  if (!el) return;
  el.innerHTML = `<div class="alert ${kind}">${text}</div>`;
}

export function initWizardPage() {
  bindHelpButtons();
}

export { helpButton, bindHelpButtons };
