'use strict';
try {
  const savedTheme = localStorage.getItem('director-ui-theme');
  document.documentElement.dataset.theme = ['light', 'dark', 'morandi'].includes(savedTheme) ? savedTheme : 'light';
} catch {
  document.documentElement.dataset.theme = 'light';
}
