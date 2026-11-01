export interface ItemTabData<T> {
	data: T,
	error?: Error
}

export const defaultItemTabData = <T>(): ItemTabData<T> => ({ data: null });
export const errorItemData = <T>(error: Error): ItemTabData<T> => ({ ...defaultItemTabData(), error })
