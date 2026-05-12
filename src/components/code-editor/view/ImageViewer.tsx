import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../utils/api';
import type { CodeEditorFile } from '../types/types';

type ImageViewerProps = {
  file: CodeEditorFile;
  onClose: () => void;
  projectPath?: string;
  isSidebar?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: (() => void) | null;
  onPopOut?: (() => void) | null;
};

export default function ImageViewer({
  file,
  onClose,
  projectPath,
  isSidebar = false,
  isExpanded = false,
  onToggleExpand = null,
  onPopOut = null,
}: ImageViewerProps) {
  const { t } = useTranslation('codeEditor');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const projectName = file.projectName ?? projectPath;

  useEffect(() => {
    if (!projectName) {
      setError('Missing project identifier');
      setLoading(false);
      return;
    }

    let cancelled = false;
    let blobUrl: string | null = null;

    const loadImage = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await api.readFileBlob(projectName, file.path);
        if (!response.ok) {
          throw new Error(`Failed to load image: ${response.status} ${response.statusText}`);
        }
        const blob = await response.blob();
        if (cancelled) {
          return;
        }
        blobUrl = URL.createObjectURL(blob);
        setImageUrl(blobUrl);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadImage();

    return () => {
      cancelled = true;
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrl = null;
      }
    };
  }, [file.path, projectName]);

  const header = (
    <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h3 className="truncate text-sm font-medium text-gray-900 dark:text-white">{file.name}</h3>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {onPopOut && (
          <button
            type="button"
            onClick={onPopOut}
            className="flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
            title="Pop out"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </button>
        )}
        {onToggleExpand && (
          <button
            type="button"
            onClick={onToggleExpand}
            className="flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
            title={isExpanded ? t('toolbar.collapse') : t('toolbar.expand')}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isExpanded ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.5 3.5M15 9h4.5M15 9V4.5M15 9l5.5-5.5M9 15v4.5M9 15H4.5M9 15l-5.5 5.5M15 15h4.5M15 15v4.5m0-4.5l5.5 5.5" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              )}
            </svg>
          </button>
        )}
        {!isSidebar && (
          <button
            type="button"
            onClick={() => setIsFullscreen((prev) => !prev)}
            className="flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
            title={isFullscreen ? t('actions.exitFullscreen') : t('actions.fullscreen')}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isFullscreen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.5 3.5M15 9h4.5M15 9V4.5M15 9l5.5-5.5M9 15v4.5M9 15H4.5M9 15l-5.5 5.5M15 15h4.5M15 15v4.5m0-4.5l5.5 5.5" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              )}
            </svg>
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
          title={t('actions.close')}
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );

  const body = (
    <div className="flex flex-1 items-center justify-center overflow-auto bg-gray-50 p-4 dark:bg-gray-950">
      {loading && (
        <div className="text-sm text-muted-foreground">Loading...</div>
      )}
      {error && (
        <div className="max-w-sm text-center text-sm text-red-600 dark:text-red-400">{error}</div>
      )}
      {imageUrl && !loading && (
        <img
          src={imageUrl}
          alt={file.name}
          className="max-h-full max-w-full object-contain"
        />
      )}
    </div>
  );

  if (isSidebar) {
    return (
      <div className="flex h-full w-full flex-col bg-background">
        {header}
        {body}
      </div>
    );
  }

  const outerClass = isFullscreen
    ? 'fixed inset-0 z-[9999] bg-background flex flex-col'
    : 'fixed inset-0 z-[9999] md:bg-black/50 md:flex md:items-center md:justify-center md:p-4';

  const innerClass = isFullscreen
    ? 'bg-background flex flex-col w-full h-full'
    : 'bg-background shadow-2xl flex flex-col w-full h-full md:rounded-lg md:shadow-2xl md:w-full md:max-w-4xl md:h-[80vh] md:max-h-[80vh]';

  return (
    <div className={outerClass}>
      <div className={innerClass}>
        {header}
        {body}
      </div>
    </div>
  );
}
