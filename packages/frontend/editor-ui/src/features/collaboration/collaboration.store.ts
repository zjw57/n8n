import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { Collaborator } from '@n8n/api-types';

import { PLACEHOLDER_EMPTY_WORKFLOW_ID, TIME } from '@/constants';
import { STORES } from '@n8n/stores';
import { useBeforeUnload } from '@/composables/useBeforeUnload';
import { useWorkflowsStore } from '@/stores/workflows.store';
import { usePushConnectionStore } from '@/stores/pushConnection.store';
import { useUsersStore } from '@/features/users/users.store';
import { useUIStore } from '@/stores/ui.store';

const HEARTBEAT_INTERVAL = 5 * TIME.MINUTE;

/**
 * Store for tracking active users for workflows. I.e. to show
 * who is collaboratively viewing/editing the workflow at the same time.
 */
export const useCollaborationStore = defineStore(STORES.COLLABORATION, () => {
	const workflowsStore = useWorkflowsStore();
	const usersStore = useUsersStore();
	const uiStore = useUIStore();

	const route = useRoute();
	const { addBeforeUnloadEventBindings, removeBeforeUnloadEventBindings, addBeforeUnloadHandler } =
		useBeforeUnload({ route });
	const unloadTimeout = ref<NodeJS.Timeout | null>(null);

	addBeforeUnloadHandler(() => {
		// Notify that workflow is closed straight away
		notifyWorkflowClosed();
		if (uiStore.stateIsDirty) {
			// If user decided to stay on the page we notify that the workflow is opened again
			unloadTimeout.value = setTimeout(() => notifyWorkflowOpened, 5 * TIME.SECOND);
		}
	});

	const collaborators = ref<Collaborator[]>([]);

	const heartbeatTimer = ref<number | null>(null);

	// Write-lock state for single-write mode
	const currentWriterId = ref<string | null>(null);
	const lastActivityTime = ref<number>(Date.now());
	const activityCheckInterval = ref<number | null>(null);

	const startHeartbeat = () => {
		stopHeartbeat();
		heartbeatTimer.value = window.setInterval(notifyWorkflowOpened, HEARTBEAT_INTERVAL);
	};

	const stopHeartbeat = () => {
		if (heartbeatTimer.value !== null) {
			clearInterval(heartbeatTimer.value);
			heartbeatTimer.value = null;
		}
	};

	// Computed properties for write-lock state
	const isCurrentUserWriter = computed(() => {
		return currentWriterId.value === usersStore.currentUserId;
	});

	const currentWriter = computed(() => {
		if (!currentWriterId.value) return null;
		return collaborators.value.find((c) => c.user.id === currentWriterId.value);
	});

	const isAnyoneWriting = computed(() => {
		return currentWriterId.value !== null;
	});

	const shouldBeReadOnly = computed(() => {
		return isAnyoneWriting.value && !isCurrentUserWriter.value;
	});

	// Write-lock methods
	function acquireWriteAccess() {
		const pushStore = usePushConnectionStore();

		if (isAnyoneWriting.value && !isCurrentUserWriter.value) {
			console.log('[Collaboration] ❌ Write access denied - another user is writing', {
				currentWriter: currentWriterId.value,
				requestingUser: usersStore.currentUserId,
			});
			return false;
		}

		currentWriterId.value = usersStore.currentUserId;
		lastActivityTime.value = Date.now();

		console.log('[Collaboration] 🔓 Write access acquired', {
			userId: usersStore.currentUserId,
			workflowId: workflowsStore.workflowId,
		});

		try {
			pushStore.send({
				type: 'writeAccessAcquired',
				workflowId: workflowsStore.workflowId,
				userId: usersStore.currentUserId,
			});
		} catch (error) {
			console.error('[Collaboration] ❌ Failed to send writeAccessAcquired message:', error);
		}

		return true;
	}

	function releaseWriteAccess() {
		const pushStore = usePushConnectionStore();

		if (!isCurrentUserWriter.value) {
			return;
		}

		console.log('[Collaboration] 🔒 Write access released', {
			userId: usersStore.currentUserId,
			workflowId: workflowsStore.workflowId,
		});

		currentWriterId.value = null;

		try {
			pushStore.send({
				type: 'writeAccessReleased',
				workflowId: workflowsStore.workflowId,
			});
		} catch (error) {
			console.error('[Collaboration] ❌ Failed to send writeAccessReleased message:', error);
		}
	}

	function recordActivity() {
		if (!isCurrentUserWriter.value) {
			return;
		}
		lastActivityTime.value = Date.now();
	}

	function checkInactivity() {
		if (!isCurrentUserWriter.value) return;

		const timeSinceActivity = Date.now() - lastActivityTime.value;
		const timeoutThreshold = 30 * TIME.SECOND;

		if (timeSinceActivity >= timeoutThreshold) {
			console.log('[Collaboration] ⏰ Inactivity timeout - releasing write access', {
				inactiveFor: `${Math.floor(timeSinceActivity / 1000)}s`,
			});
			releaseWriteAccess();
		}
	}

	function stopInactivityCheck() {
		if (activityCheckInterval.value !== null) {
			clearInterval(activityCheckInterval.value);
			activityCheckInterval.value = null;
		}
	}

	function startInactivityCheck() {
		stopInactivityCheck();
		activityCheckInterval.value = window.setInterval(checkInactivity, 1000);
	}

	const pushStoreEventListenerRemovalFn = ref<(() => void) | null>(null);

	function initialize() {
		const pushStore = usePushConnectionStore();

		if (pushStoreEventListenerRemovalFn.value) {
			return;
		}

		pushStoreEventListenerRemovalFn.value = pushStore.addEventListener((event) => {
			if (
				event.type === 'collaboratorsChanged' &&
				event.data.workflowId === workflowsStore.workflowId
			) {
				collaborators.value = event.data.collaborators;
				console.log('[Collaboration] 👥 Collaborators updated', {
					count: event.data.collaborators.length,
					users: event.data.collaborators.map((c) => c.user.email),
				});
				return;
			}

			if (
				event.type === 'writeAccessAcquired' &&
				event.data.workflowId === workflowsStore.workflowId
			) {
				currentWriterId.value = event.data.userId;
				const writer = collaborators.value.find((c) => c.user.id === event.data.userId);
				console.log(
					'[Collaboration] 🔓 Write access acquired by:',
					writer?.user.email || event.data.userId,
				);
				return;
			}

			if (
				event.type === 'writeAccessReleased' &&
				event.data.workflowId === workflowsStore.workflowId
			) {
				const previousWriterId = currentWriterId.value;
				currentWriterId.value = null;
				console.log('[Collaboration] 🔒 Write access released');

				// Acquire write access if I'm the first in collaborators list (excluding previous writer)
				const sortedCollaborators = [...collaborators.value]
					.filter((c) => c.user.id !== previousWriterId)
					.sort((a, b) => a.user.id.localeCompare(b.user.id)); // Deterministic order TODO: we want to order by lastOpened

				if (
					sortedCollaborators.length > 0 &&
					sortedCollaborators[0].user.id === usersStore.currentUserId
				) {
					console.log('[Collaboration] 🎯 Next in queue - acquiring write access');
					// Small delay to avoid race conditions
					setTimeout(() => acquireWriteAccess(), 100);
				}
				return;
			}
		});

		addBeforeUnloadEventBindings();
		notifyWorkflowOpened();
		startHeartbeat();
		startInactivityCheck();
	}

	function terminate() {
		const pushStore = usePushConnectionStore();

		if (typeof pushStoreEventListenerRemovalFn.value === 'function') {
			pushStoreEventListenerRemovalFn.value();
			pushStoreEventListenerRemovalFn.value = null;
		}
		notifyWorkflowClosed();
		stopHeartbeat();
		stopInactivityCheck();
		if (isCurrentUserWriter.value) {
			releaseWriteAccess();
		}
		pushStore.clearQueue();
		removeBeforeUnloadEventBindings();
		if (unloadTimeout.value) {
			clearTimeout(unloadTimeout.value);
		}
	}

	function notifyWorkflowOpened() {
		const pushStore = usePushConnectionStore();
		const { workflowId } = workflowsStore;
		if (workflowId === PLACEHOLDER_EMPTY_WORKFLOW_ID) return;
		pushStore.send({ type: 'workflowOpened', workflowId });
	}

	function notifyWorkflowClosed() {
		const pushStore = usePushConnectionStore();
		const { workflowId } = workflowsStore;
		if (workflowId === PLACEHOLDER_EMPTY_WORKFLOW_ID) return;
		pushStore.send({ type: 'workflowClosed', workflowId });

		collaborators.value = collaborators.value.filter(
			({ user }) => user.id !== usersStore.currentUserId,
		);
	}

	return {
		collaborators,
		currentWriter,
		isCurrentUserWriter,
		isAnyoneWriting,
		shouldBeReadOnly,
		acquireWriteAccess,
		releaseWriteAccess,
		recordActivity,
		initialize,
		terminate,
		startHeartbeat,
		stopHeartbeat,
	};
});
