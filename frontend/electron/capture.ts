declare const multiscaleCapture: { save(text: string): Promise<void>; dismiss(): Promise<void> };

const field = document.querySelector('input')!;
const problem = document.querySelector<HTMLElement>('[data-problem]')!;

let saving = false;

async function save() {
  if (saving || !field.value.trim()) return;
  saving = true;
  problem.hidden = true;
  try {
    await multiscaleCapture.save(field.value);
    field.value = '';
  } catch {
    // The text stays in the field, so nothing is lost.
    problem.hidden = false;
  } finally {
    saving = false;
  }
}

field.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void save();
  if (event.key === 'Escape') {
    field.value = '';
    problem.hidden = true;
    void multiscaleCapture.dismiss();
  }
});

window.addEventListener('focus', () => field.focus());
field.focus();
