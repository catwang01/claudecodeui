# File Upload Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to attach any file to a chat message; the server saves it to /tmp and appends the file path to the message sent to the AI.

**Architecture:** New `POST /api/projects/:projectName/upload-files` endpoint stores files under `/tmp/claude-ui-uploads/[userId]/` and returns server paths. The hook appends paths to `messageContent` before sending via WebSocket. ChatComposer gains a paperclip button + file list display, wired through the same prop-flow pattern already used for image attachments.

**Tech Stack:** Express + multer (backend); React hooks + hidden `<input type="file">` (frontend); TypeScript throughout.

---

## File Map

| File | Change |
|------|--------|
| `server/index.js` | Add `POST /api/projects/:projectName/upload-files` after line ~2301 |
| `src/components/chat/hooks/useChatComposerState.ts` | Add file state, `openFilePicker`, `handleFileInputChange`, `handleRemoveFile`; modify `handleSubmit` to upload and append paths |
| `src/components/chat/view/subcomponents/ChatComposer.tsx` | Add props, hidden file input, file list, paperclip button; widen textarea left padding |
| `src/components/chat/view/ChatInterface.tsx` | Pass new file props to ChatComposer |

---

## Task 1: Backend — file upload endpoint

**Files:**
- Modify: `server/index.js` (after line 2301, after the closing `});` of the upload-images handler)

- [ ] **Step 1: Add endpoint**

Find the line containing `// End of upload-images` or the closing `});` of the `upload-images` handler (around line 2301). Insert immediately after:

```javascript
app.post('/api/projects/:projectName/upload-files', authenticateToken, async (req, res) => {
  try {
    const multer = (await import('multer')).default;
    const path = (await import('path')).default;
    const fs = (await import('fs')).promises;
    const os = (await import('os')).default;

    const storage = multer.diskStorage({
      destination: async (req, file, cb) => {
        const uploadDir = path.join(os.tmpdir(), 'claude-ui-uploads', String(req.user.id));
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, uniqueSuffix + '-' + sanitizedName);
      },
    });

    const upload = multer({
      storage,
      limits: { fileSize: 50 * 1024 * 1024, files: 10 },
    });

    upload.array('files', 10)(req, res, async (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files provided' });
      }
      const files = req.files.map((file) => ({
        name: file.originalname,
        path: file.path,
        size: file.size,
      }));
      res.json({ files });
    });
  } catch (error) {
    console.error('Error in file upload endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

- [ ] **Step 2: Smoke-test the endpoint**

```bash
# Start server if not running, then:
curl -s -X POST http://localhost:3000/api/projects/test/upload-files \
  -H "Authorization: Bearer $(cat /tmp/test-token 2>/dev/null || echo 'test')" \
  -F "files=@/etc/hostname"
```
Expected: JSON with `files` array containing `name`, `path`, `size`. (Auth failure is fine here — the important thing is the route exists and doesn't 500.)

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat(api): add POST /upload-files endpoint for any file type"
```

---

## Task 2: Hook — file state + upload logic

**Files:**
- Modify: `src/components/chat/hooks/useChatComposerState.ts`

- [ ] **Step 1: Add state declarations (line 147, after `imageErrors` state)**

Find:
```typescript
  const [imageErrors, setImageErrors] = useState<Map<string, string>>(new Map());
```

Replace with:
```typescript
  const [imageErrors, setImageErrors] = useState<Map<string, string>>(new Map());
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
```

- [ ] **Step 2: Add file callbacks (after `handleImageFiles` callback, around line 428)**

Find:
```typescript
  const handlePaste = useCallback(
```

Insert before it:
```typescript
  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length > 0) {
      setAttachedFiles((previous) => [...previous, ...files].slice(0, 10));
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const handleRemoveFile = useCallback((index: number) => {
    setAttachedFiles((previous) => previous.filter((_, i) => i !== index));
  }, []);

```

- [ ] **Step 3: Upload files in handleSubmit (after the image upload block)**

In `handleSubmit`, find the end of the image upload block:
```typescript
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          logger.error('Image upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload images: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }
```

Insert immediately after the closing `}` of that `if (attachedImages.length > 0)` block:
```typescript

      if (attachedFiles.length > 0) {
        const formData = new FormData();
        attachedFiles.forEach((file) => {
          formData.append('files', file);
        });
        try {
          const response = await authenticatedFetch(
            `/api/projects/${selectedProject.name}/upload-files`,
            { method: 'POST', headers: {}, body: formData },
          );
          if (!response.ok) {
            throw new Error('Failed to upload files');
          }
          const result = await response.json();
          const paths = result.files
            .map((f: { path: string }) => `- ${f.path}`)
            .join('\n');
          messageContent = `${messageContent}\n\nAttached files:\n${paths}`;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          logger.error('File upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }
```

- [ ] **Step 4: Clear file state on submit (line 668–670 area)**

Find:
```typescript
      setAttachedImages([]);
      setUploadingImages(new Map());
      setImageErrors(new Map());
```

Replace with:
```typescript
      setAttachedImages([]);
      setUploadingImages(new Map());
      setImageErrors(new Map());
      setAttachedFiles([]);
```

- [ ] **Step 5: Add `attachedFiles` to the `handleSubmit` `useCallback` dependency array**

Find the deps array of `handleSubmit` (around line 680):
```typescript
    [
      selectedSession,
      attachedImages,
```

Replace with:
```typescript
    [
      selectedSession,
      attachedImages,
      attachedFiles,
```

- [ ] **Step 6: Add new values to the return object**

Find:
```typescript
    openImagePicker: open,
```

Replace with:
```typescript
    openImagePicker: open,
    attachedFiles,
    setAttachedFiles,
    fileInputRef,
    openFilePicker,
    handleFileInputChange,
    handleRemoveFile,
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
cd /Users/tanhuan/claudecodeui && npx tsc --noEmit 2>&1 | head -40
```
Expected: no errors related to the changes above.

- [ ] **Step 8: Commit**

```bash
git add src/components/chat/hooks/useChatComposerState.ts
git commit -m "feat(hook): add file attachment state and upload logic"
```

---

## Task 3: ChatComposer — UI for file attachment

**Files:**
- Modify: `src/components/chat/view/subcomponents/ChatComposer.tsx`

- [ ] **Step 1: Add ChangeEvent to the React import**

Find:
```typescript
import type {
  ChangeEvent,
```
It's already imported — no change needed. Confirm by checking line 3.

- [ ] **Step 2: Add props to `ChatComposerProps` interface (after the `openImagePicker` line)**

Find:
```typescript
  openImagePicker: () => void;
```

Replace with:
```typescript
  openImagePicker: () => void;
  attachedFiles: File[];
  onRemoveFile: (index: number) => void;
  fileInputRef: RefObject<HTMLInputElement>;
  onFileInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  openFilePicker: () => void;
```

- [ ] **Step 3: Add new params to the function signature**

Find:
```typescript
  openImagePicker,
  inputHighlightRef,
```

Replace with:
```typescript
  openImagePicker,
  attachedFiles,
  onRemoveFile,
  fileInputRef,
  onFileInputChange,
  openFilePicker,
  inputHighlightRef,
```

- [ ] **Step 4: Add the hidden file input inside the dropzone div**

Find the existing dropzone input:
```typescript
          <input {...getInputProps()} />
```

Replace with:
```typescript
          <input {...getInputProps()} />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onFileInputChange}
          />
```

- [ ] **Step 5: Add attached-files list display (after the attached-images block)**

Find:
```typescript
        {attachedImages.length > 0 && (
          <div className="mb-2 rounded-xl bg-muted/40 p-2">
            <div className="flex flex-wrap gap-2">
              {attachedImages.map((file, index) => (
                <ImageAttachment
                  key={index}
                  file={file}
                  onRemove={() => onRemoveImage(index)}
                  uploadProgress={uploadingImages.get(file.name)}
                  error={imageErrors.get(file.name)}
                />
              ))}
            </div>
          </div>
        )}
```

Replace with:
```typescript
        {attachedImages.length > 0 && (
          <div className="mb-2 rounded-xl bg-muted/40 p-2">
            <div className="flex flex-wrap gap-2">
              {attachedImages.map((file, index) => (
                <ImageAttachment
                  key={index}
                  file={file}
                  onRemove={() => onRemoveImage(index)}
                  uploadProgress={uploadingImages.get(file.name)}
                  error={imageErrors.get(file.name)}
                />
              ))}
            </div>
          </div>
        )}

        {attachedFiles.length > 0 && (
          <div className="mb-2 rounded-xl bg-muted/40 p-2">
            <div className="flex flex-wrap gap-2">
              {attachedFiles.map((file, index) => (
                <div
                  key={index}
                  className="flex items-center gap-1 rounded-lg border border-border/40 bg-card px-2 py-1 text-sm"
                >
                  <svg
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                    />
                  </svg>
                  <span className="max-w-[200px] truncate text-foreground">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveFile(index)}
                    className="ml-0.5 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
```

- [ ] **Step 6: Add paperclip button and update textarea padding**

The existing image button sits at `left-2`. Add the paperclip button at `left-10`. Then update the textarea (and its overlay div) left padding from `pl-12` to `pl-20` to accommodate both buttons.

Find the image button block:
```typescript
            <button
              type="button"
              onClick={openImagePicker}
              className="absolute left-2 top-1/2 -translate-y-1/2 transform rounded-xl p-2 transition-colors hover:bg-accent/60"
              title={t('input.attachImages')}
            >
```

Replace with:
```typescript
            <button
              type="button"
              onClick={openImagePicker}
              className="absolute left-2 top-1/2 -translate-y-1/2 transform rounded-xl p-2 transition-colors hover:bg-accent/60"
              title={t('input.attachImages')}
            >
```
(No change to image button.)

After the closing `</button>` of the image button, insert:
```typescript

            <button
              type="button"
              onClick={openFilePicker}
              className="absolute left-10 top-1/2 -translate-y-1/2 transform rounded-xl p-2 transition-colors hover:bg-accent/60"
              title={t('input.attachFiles', { defaultValue: 'Attach files' })}
            >
              <svg
                className="h-5 w-5 text-muted-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                />
              </svg>
            </button>
```

Now update the textarea padding. Find **both** occurrences of `pl-12` in the component and change them to `pl-20`:

First occurrence (the highlight overlay div):
```typescript
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
```
Search for `pl-12` — there are exactly 2 instances in this file (the overlay div and the textarea). Replace both `pl-12` with `pl-20`.

```
# In overlay div: pl-12 → pl-20
# In textarea: pl-12 → pl-20
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
cd /Users/tanhuan/claudecodeui && npx tsc --noEmit 2>&1 | head -40
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/chat/view/subcomponents/ChatComposer.tsx
git commit -m "feat(ui): add file attachment button and list to ChatComposer"
```

---

## Task 4: Wire ChatInterface

**Files:**
- Modify: `src/components/chat/view/ChatInterface.tsx`

- [ ] **Step 1: Destructure new values from the hook**

In `ChatInterface.tsx`, find where the hook return values are destructured (look for `openImagePicker`):

```typescript
    openImagePicker,
```

Add after it:
```typescript
    attachedFiles,
    setAttachedFiles,
    fileInputRef,
    openFilePicker,
    handleFileInputChange,
    handleRemoveFile,
```

- [ ] **Step 2: Pass new props to ChatComposer**

Find in the ChatComposer JSX (around line 450):
```typescript
          openImagePicker={openImagePicker}
```

Add after it:
```typescript
          attachedFiles={attachedFiles}
          onRemoveFile={handleRemoveFile}
          fileInputRef={fileInputRef}
          onFileInputChange={handleFileInputChange}
          openFilePicker={openFilePicker}
```

- [ ] **Step 3: Verify TypeScript compiles cleanly**

```bash
cd /Users/tanhuan/claudecodeui && npx tsc --noEmit 2>&1 | head -40
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/view/ChatInterface.tsx
git commit -m "feat(chat): wire file upload props through ChatInterface"
```

---

## Task 5: Manual verification

- [ ] **Step 1: Start the dev server**

```bash
cd /Users/tanhuan/claudecodeui && npm run dev
```

- [ ] **Step 2: Test file attachment**

1. Open the app in browser
2. Click the paperclip button — file picker dialog should open
3. Select any file (e.g., a .txt or .pdf)
4. File name should appear in the chip list below the textarea
5. Click the ✕ on the chip — file should be removed
6. Re-attach a file, type a message, send it
7. The message sent to Claude should include `\n\nAttached files:\n- /tmp/...`
8. Check server logs for the POST to `/upload-files` returning 200

- [ ] **Step 3: Test edge cases**

- Select 11 files — only 10 should be kept
- Send without typing any message text — should still work (just the file path block)
- After send, chip list should be empty

- [ ] **Step 4: Final commit**

```bash
git add -p  # review any stray changes
git commit -m "feat: file upload — users can attach any file to chat messages"
```
