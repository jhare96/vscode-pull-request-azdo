/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ITelemetry {
	sendTelemetryEvent(
		eventName: string,
		properties?: {
			[key: string]: string;
		},
		measurements?: {
			[key: string]: number;
		},
	): void;
	sendTelemetryErrorEvent(
		eventName: string,
		properties?: {
			[key: string]: string;
		},
		measurements?: {
			[key: string]: number;
		},
	): void;
	dispose(): Promise<any>;
}

/** Retains shared workflow instrumentation without creating a reporter or sending data. */
export class NullTelemetry implements ITelemetry {
	sendTelemetryEvent(_eventName: string, _properties?: Record<string, string>, _measurements?: Record<string, number>): void { }
	sendTelemetryErrorEvent(_eventName: string, _properties?: Record<string, string>, _measurements?: Record<string, number>): void { }
	async dispose(): Promise<void> { }
}
