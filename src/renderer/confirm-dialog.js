(function () {
  'use strict';
  let pending = Promise.resolve();
  window.directorConfirm = function (message, options = {}) {
    const run = () => new Promise(resolve => {
      const previousFocus = document.activeElement;
      const dialog = document.createElement('dialog');
      dialog.className = 'director-confirm-dialog';
      const heading = document.createElement('h2');
      heading.textContent = options.title || '请确认';
      const description = document.createElement('p');
      description.textContent = String(message);
      const actions = document.createElement('div');
      actions.className = 'form-actions';
      const cancel = document.createElement('button');
      cancel.className = 'button secondary';
      cancel.textContent = options.cancelLabel || '取消';
      cancel.dataset.confirmChoice = 'cancel';
      const accept = document.createElement('button');
      accept.className = 'button';
      accept.textContent = options.confirmLabel || '确定';
      accept.dataset.confirmChoice = 'accept';
      actions.append(cancel, accept);
      dialog.append(heading, description, actions);
      document.body.append(dialog);
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        dialog.close();
        dialog.remove();
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        resolve(value);
      };
      cancel.addEventListener('click', () => finish(false));
      accept.addEventListener('click', () => finish(true));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      dialog.addEventListener('close', () => finish(false));
      dialog.showModal();
      cancel.focus();
    });
    const result = pending.then(run, run);
    pending = result.catch(() => false);
    return result;
  };
})();
