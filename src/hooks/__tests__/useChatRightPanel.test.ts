import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatRightPanel } from '../useChatRightPanel';

beforeEach(() => {
  localStorage.clear();
});

describe('useChatRightPanel', () => {
  it('starts closed with defaults', () => {
    const { result } = renderHook(() => useChatRightPanel());
    expect(result.current.state).toEqual({
      open: false,
      activeTab: 'files',
      width: 360,
      editingFile: null,
      editorExpanded: false,
    });
  });

  it('toggle("files") opens panel on files tab', () => {
    const { result } = renderHook(() => useChatRightPanel());
    act(() => result.current.toggle('files'));
    expect(result.current.state.open).toBe(true);
    expect(result.current.state.activeTab).toBe('files');
  });

  it('toggle("files") while open on files closes panel', () => {
    const { result } = renderHook(() => useChatRightPanel());
    act(() => result.current.toggle('files'));
    act(() => result.current.toggle('files'));
    expect(result.current.state.open).toBe(false);
  });

  it('toggle("git") while open on files switches tab (does not close)', () => {
    const { result } = renderHook(() => useChatRightPanel());
    act(() => result.current.toggle('files'));
    act(() => result.current.toggle('git'));
    expect(result.current.state.open).toBe(true);
    expect(result.current.state.activeTab).toBe('git');
  });

  it('close() sets open to false', () => {
    const { result } = renderHook(() => useChatRightPanel());
    act(() => result.current.toggle('git'));
    act(() => result.current.close());
    expect(result.current.state.open).toBe(false);
  });

  it('setWidth clamps to [200, 800]', () => {
    const { result } = renderHook(() => useChatRightPanel());
    act(() => result.current.setWidth(50));
    expect(result.current.state.width).toBe(200);
    act(() => result.current.setWidth(1200));
    expect(result.current.state.width).toBe(800);
    act(() => result.current.setWidth(500));
    expect(result.current.state.width).toBe(500);
  });

  it('persists state to localStorage key "rightPanel.state"', () => {
    const { result } = renderHook(() => useChatRightPanel());
    act(() => result.current.toggle('git'));
    const stored = JSON.parse(localStorage.getItem('rightPanel.state') ?? '{}');
    expect(stored.open).toBe(true);
    expect(stored.activeTab).toBe('git');
  });

  it('reads initial state from localStorage', () => {
    localStorage.setItem(
      'rightPanel.state',
      JSON.stringify({ open: true, activeTab: 'git', width: 450 }),
    );
    const { result } = renderHook(() => useChatRightPanel());
    expect(result.current.state).toEqual({
      open: true,
      activeTab: 'git',
      width: 450,
      editingFile: null,
      editorExpanded: false,
    });
  });
});
