import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';
import type { Project } from '../../../types/app';
import type { FileTreeNode } from '../types/types';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  refreshFiles: () => void;
  loadChildren: (dirPath: string) => void;
};

/** Recursively mark directory nodes with appropriate childrenStatus based on fetched children */
function markDirectoriesUnloaded(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.type === 'directory') {
      if (node.children && node.children.length > 0) {
        return { ...node, children: markDirectoriesUnloaded(node.children), childrenStatus: 'loaded' as const };
      }
      return { ...node, children: [], childrenStatus: 'unloaded' as const };
    }
    return node;
  });
}

/** Recursively update a node at targetPath, applying updater to it */
function updateNodeAtPath(
  nodes: FileTreeNode[],
  targetPath: string,
  updater: (node: FileTreeNode) => FileTreeNode,
): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return updater(node);
    }
    if (node.type === 'directory' && node.children && node.children.length > 0) {
      return { ...node, children: updateNodeAtPath(node.children, targetPath, updater) };
    }
    return node;
  });
}

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const projectNameRef = useRef<string | undefined>(undefined);

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    const projectName = selectedProject?.name;
    projectNameRef.current = projectName;

    if (!projectName) {
      setFiles([]);
      setLoading(false);
      return;
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    let isActive = true;

    const fetchFiles = async () => {
      if (isActive) {
        setLoading(true);
      }
      try {
        const response = await api.getFiles(projectName, {
          depth: 3,
          signal: abortControllerRef.current!.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            setFiles([]);
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          setFiles(markDirectoriesUnloaded(data));
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive) {
          setFiles([]);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
    };
  }, [selectedProject?.name, refreshKey]);

  const loadChildren = useCallback(
    (dirPath: string) => {
      const projectName = projectNameRef.current;
      if (!projectName) return;

      // Prevent duplicate in-flight requests
      setFiles((prev) => {
        const findNode = (nodes: FileTreeNode[]): FileTreeNode | null => {
          for (const n of nodes) {
            if (n.path === dirPath) return n;
            if (n.children) {
              const found = findNode(n.children);
              if (found) return found;
            }
          }
          return null;
        };
        const node = findNode(prev);
        if (!node || node.childrenStatus !== 'unloaded') return prev;
        return updateNodeAtPath(prev, dirPath, (n) => ({ ...n, childrenStatus: 'loading' as const }));
      });

      const fetchChildren = async () => {
        try {
          const response = await api.getFiles(projectName, { path: dirPath, depth: 1 });
          if (!response.ok) {
            setFiles((prev) =>
              updateNodeAtPath(prev, dirPath, (n) => ({ ...n, childrenStatus: 'unloaded' as const })),
            );
            return;
          }
          const data = (await response.json()) as FileTreeNode[];
          const children = markDirectoriesUnloaded(data);
          setFiles((prev) =>
            updateNodeAtPath(prev, dirPath, (n) => ({
              ...n,
              children,
              childrenStatus: 'loaded' as const,
            })),
          );
        } catch (error) {
          console.error('Error loading children:', error);
          setFiles((prev) =>
            updateNodeAtPath(prev, dirPath, (n) => ({ ...n, childrenStatus: 'unloaded' as const })),
          );
        }
      };

      void fetchChildren();
    },
    [],
  );

  return {
    files,
    loading,
    refreshFiles,
    loadChildren,
  };
}
