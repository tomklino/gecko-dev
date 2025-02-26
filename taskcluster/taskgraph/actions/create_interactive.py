# -*- coding: utf-8 -*-

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from __future__ import absolute_import, print_function, unicode_literals

import logging
import re
import taskcluster_urls

from .util import (
    create_tasks,
    fetch_graph_and_labels
)
from taskgraph.util.taskcluster import (
    send_email,
    get_root_url,
)
from .registry import register_callback_action
from taskgraph.util import taskcluster


logger = logging.getLogger(__name__)

EMAIL_SUBJECT = 'Your Interactive Task for {label}'
EMAIL_CONTENT = '''\
As you requested, Firefox CI has created an interactive task to run {label}
on revision {revision} in {repo}. Click the button below to connect to the
task. You may need to wait for it to begin running.
'''

###
# Security Concerns
#
# An "interactive task" is, quite literally, shell access to a worker. That
# is limited by being in a Docker container, but we assume that Docker has
# bugs so we do not want to rely on container isolation exclusively.
#
# Interactive tasks should never be allowed on hosts that build binaries
# leading to a release -- level 3 builders.
#
# Users must not be allowed to create interactive tasks for tasks above
# their own level.
#
# Interactive tasks must not have any routes that might make them appear
# in the index to be used by other production tasks.
#
# Interactive tasks should not be able to write to any docker-worker caches.

SCOPE_WHITELIST = [
    # this is not actually secret, and just about everything needs it
    re.compile(r'^secrets:get:project/taskcluster/gecko/hgfingerprint$'),
    # public downloads are OK
    re.compile(r'^docker-worker:relengapi-proxy:tooltool.download.public$'),
    # level-appropriate secrets are generally necessary to run a task; these
    # also are "not that secret" - most of them are built into the resulting
    # binary and could be extracted by someone with `strings`.
    re.compile(r'^secrets:get:project/releng/gecko/build/level-[0-9]/\*'),
    # ptracing is generally useful for interactive tasks, too!
    re.compile(r'^docker-worker:feature:allowPtrace$'),
    # docker-worker capabilities include loopback devices
    re.compile(r'^docker-worker:capability:device:.*$'),
]


def context(params):
    # available for any docker-worker tasks at levels 1, 2; and for
    # test tasks on level 3 (level-3 builders are firewalled off)
    if int(params['level']) < 3:
        return [{'worker-implementation': 'docker-worker'}]
    else:
        return [{'worker-implementation': 'docker-worker', 'kind': 'test'}]


@register_callback_action(
    title='Create Interactive Task',
    name='create-interactive',
    symbol='create-inter',
    kind='hook',
    generic=True,
    description=(
        'Create a a copy of the task that you can interact with'
    ),
    order=50,
    context=context,
    schema={
        'type': 'object',
        'properties': {
            'notify': {
                'type': 'string',
                'format': 'email',
                'title': 'Who to notify of the pending interactive task',
                'description': (
                    'Enter your email here to get an email containing a link '
                    'to interact with the task'
                ),
                # include a default for ease of users' editing
                'default': 'noreply@noreply.mozilla.org',
            },
        },
        'additionalProperties': False,
    },
)
def create_interactive_action(parameters, graph_config, input, task_group_id, task_id):
    # fetch the original task definition from the taskgraph, to avoid
    # creating interactive copies of unexpected tasks.  Note that this only applies
    # to docker-worker tasks, so we can assume the docker-worker payload format.
    decision_task_id, full_task_graph, label_to_taskid = fetch_graph_and_labels(
        parameters, graph_config)
    task = taskcluster.get_task_definition(task_id)
    label = task['metadata']['name']

    def edit(task):
        if task.label != label:
            return task
        task_def = task.task

        # drop task routes (don't index this!)
        task_def['routes'] = []

        # only try this once
        task_def['retries'] = 0

        # short expirations, at least 3 hour maxRunTime
        task_def['deadline'] = {'relative-datestamp': '12 hours'}
        task_def['created'] = {'relative-datestamp': '0 hours'}
        task_def['expires'] = {'relative-datestamp': '1 day'}

        # filter scopes with the SCOPE_WHITELIST
        task.task['scopes'] = [s for s in task.task.get('scopes', [])
                               if any(p.match(s) for p in SCOPE_WHITELIST)]

        payload = task_def['payload']

        # make sure the task runs for long enough..
        payload['maxRunTime'] = max(3600 * 3, payload.get('maxRunTime', 0))

        # no caches or artifacts
        payload['cache'] = {}
        payload['artifacts'] = {}

        # enable interactive mode
        payload.setdefault('features', {})['interactive'] = True
        payload.setdefault('env', {})['TASKCLUSTER_INTERACTIVE'] = 'true'

        return task

    # Create the task and any of its dependencies. This uses a new taskGroupId to avoid
    # polluting the existing taskGroup with interactive tasks.
    label_to_taskid = create_tasks(graph_config, [label], full_task_graph, label_to_taskid,
                                   parameters, modifier=edit)

    taskId = label_to_taskid[label]
    logger.info('Created interactive task {}; sending notification'.format(taskId))

    if input and 'notify' in input:
        email = input['notify']
        # no point sending to a noreply address!
        if email == 'noreply@noreply.mozilla.org':
            return

        info = {
            'url': taskcluster_urls.ui(get_root_url(), 'tasks/{}/connect'.format(taskId)),
            'label': label,
            'revision': parameters['head_rev'],
            'repo': parameters['head_repository'],
        }
        send_email(
            email,
            subject=EMAIL_SUBJECT.format(**info),
            content=EMAIL_CONTENT.format(**info),
            link={
                'text': 'Connect',
                'href': info['url'],
            },
            use_proxy=True)
