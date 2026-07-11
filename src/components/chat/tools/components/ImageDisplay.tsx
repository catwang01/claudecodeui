import React, { useState } from 'react';

interface ImageDisplayProps {
  filename: string;
  filepath: string;
  imageUrl: string;
  fileSize: number;
  mimeType: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const ImageDisplay: React.FC<ImageDisplayProps> = ({ filename, imageUrl, fileSize, mimeType }) => {
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const token = localStorage.getItem('auth-token');
  const authedUrl = `${imageUrl}${imageUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token || '')}`;

  const handleOpenFull = () => {
    window.open(authedUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
      <div className="relative">
        {!error ? (
          <img
            src={authedUrl}
            alt={filename}
            className={`max-h-96 w-full cursor-zoom-in object-contain transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
            onLoad={() => setLoaded(true)}
            onError={() => setError(true)}
            onClick={handleOpenFull}
          />
        ) : (
          <div className="flex h-32 items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            Failed to load image
          </div>
        )}
        {!loaded && !error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <svg className="h-6 w-6 animate-spin text-gray-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{filename}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {mimeType}{fileSize > 0 ? ` · ${formatFileSize(fileSize)}` : ''}
          </div>
        </div>
        <button
          onClick={handleOpenFull}
          title="Open in new tab"
          className="ml-3 flex-shrink-0 rounded-md p-1.5 text-gray-500 hover:bg-gray-200 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
          </svg>
        </button>
      </div>
    </div>
  );
};
