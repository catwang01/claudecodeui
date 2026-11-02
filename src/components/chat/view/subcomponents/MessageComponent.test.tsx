import { render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import chat from '../../../../i18n/locales/en/chat.json';
import MessageComponent from './MessageComponent';

const i18n = createInstance();

beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { chat } },
    interpolation: { escapeValue: false },
  });
});

describe('assistant message provider identity', () => {
  it('shows the Copilot name and avatar rather than Claude for a Copilot reply', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MessageComponent
          message={{ type: 'assistant', content: 'Hello', timestamp: '2026-11-02T00:00:00Z' }}
          prevMessage={null}
          createDiff={() => []}
          provider="copilot"
        />
      </I18nextProvider>
    );

    expect(screen.getByText('Copilot')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Copilot' })).toHaveAttribute('src', '/icons/copilot.svg');
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
  });
});
