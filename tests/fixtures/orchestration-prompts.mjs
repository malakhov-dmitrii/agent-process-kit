export const clearPrompts = Object.freeze([
  'Fix the typo in the README heading',
  'Добавь поддержку импорта CSV в отчёт',
]);

export const ambiguousPrompts = Object.freeze([
  'Improve onboarding and choose the best workflow for new users',
]);

export const naturalCommands = Object.freeze({
  release: ['кати', 'катим', 'ship'],
  continue: ['+', 'продолжай'],
  status: ['дай статус'],
  pause: ['pause', 'стоп'],
});
