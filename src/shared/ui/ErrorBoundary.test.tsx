import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

const originalLanguage = document.documentElement.lang;
afterEach(() => { document.documentElement.lang = originalLanguage; vi.restoreAllMocks(); });

describe('render failure recovery', () => {
  it('names the failed screen, keeps diagnostics as collapsed text and retries only that screen', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    document.documentElement.lang = 'ko-KR';
    let fail = true;
    const diagnostic = '<img src=x onerror=synthetic()> engine view failed';
    function Panel() { if (fail) throw new Error(diagnostic); return <p>Panel recovered</p>; }
    const { container } = render(<><input aria-label="Other screen draft" defaultValue="synthetic note" />
      <ErrorBoundary label="프로젝트"><Panel /></ErrorBoundary></>);
    expect(screen.getByRole('alert')).toHaveTextContent('프로젝트 화면을 표시하지 못했습니다');
    expect(screen.getByRole('alert')).toHaveTextContent('실행 중인 작업을 확인한 뒤');
    const disclosure = screen.getByText('오류 내용').closest('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    expect(screen.getByText(diagnostic)).not.toBeVisible();
    expect(container.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByText('오류 내용'));
    expect(screen.getByText(diagnostic)).toBeVisible();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '이 화면 다시 시도' }));
    expect(screen.getByText('Panel recovered')).toBeVisible();
    expect(screen.getByLabelText('Other screen draft')).toHaveValue('synthetic note');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('can explain a root failure without relying on an i18n provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    document.documentElement.lang = 'unsupported-language';
    function Broken(): never { throw new Error('synthetic bootstrap render error'); }
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toHaveTextContent('This screen could not be displayed');
    expect(screen.getByRole('button', { name: 'Try this screen again' })).toBeVisible();
  });
});
