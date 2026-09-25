import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../src/App';

describe('web 包冒烟', () => {
  it('App 能渲染且显示合规声明', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: '私局德州' })).toBeInTheDocument();
    expect(screen.getByText(/非商业运营/)).toBeInTheDocument();
  });
});
