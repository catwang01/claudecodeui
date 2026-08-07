import { useEffect, useState } from 'react';
import { COPILOT_MODELS } from '../../shared/modelConstants';
import { api } from '../utils/api';

export type ModelOption = { value: string; label: string };

let cachedModels: ModelOption[] | null = null;
let modelsRequest: Promise<ModelOption[]> | null = null;

function fetchCopilotModels(): Promise<ModelOption[]> {
  if (cachedModels) return Promise.resolve(cachedModels);
  if (modelsRequest) return modelsRequest;

  modelsRequest = api.copilotModels()
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to load Copilot models: ${response.status}`);
      }
      const data = await response.json() as { models?: ModelOption[] };
      if (!Array.isArray(data.models) || data.models.length === 0) {
        throw new Error('Copilot SDK returned no models');
      }
      cachedModels = data.models;
      return data.models;
    })
    .finally(() => {
      modelsRequest = null;
    });

  return modelsRequest;
}

export function useCopilotModels(): { models: ModelOption[]; loadedFromSdk: boolean } {
  const [models, setModels] = useState<ModelOption[]>(
    cachedModels ?? COPILOT_MODELS.OPTIONS,
  );
  const [loadedFromSdk, setLoadedFromSdk] = useState(cachedModels !== null);

  useEffect(() => {
    let active = true;
    fetchCopilotModels()
      .then((nextModels) => {
        if (active) {
          setModels(nextModels);
          setLoadedFromSdk(true);
        }
      })
      .catch((error) => {
        console.error('Failed to load Copilot models from SDK:', error);
      });
    return () => {
      active = false;
    };
  }, []);

  return { models, loadedFromSdk };
}
