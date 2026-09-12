import { createContext, useContext } from 'react';

export const TuningIdScope = createContext('tuning');
export const useTuningId = () => useContext(TuningIdScope);
