import json
import logging
import os
import re
import uuid

import boto3

logger = logging.getLogger(__name__)

def get_sqs_client():
    endpoint = os.environ.get('SQS_ENDPOINT_URL')
    region = os.environ.get('AWS_DEFAULT_REGION', 'us-east-1')
    if endpoint:
        return boto3.client('sqs', endpoint_url=endpoint, region_name=region)
    return boto3.client('sqs', region_name=region)

def _is_dlq_of(source_queue, target_arn):
    rp = source_queue['attributes'].get('RedrivePolicy')
    if not rp:
        return False
    try:
        return json.loads(rp).get('deadLetterTargetArn') == target_arn
    except Exception:
        return False

def cors_response(status, body=None):
    return {
        'statusCode': status,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': '*',
            'Access-Control-Allow-Headers': '*',
        },
        'body': json.dumps(body, default=str) if body is not None else '',
    }

def lambda_handler(event, context):
    method = event.get('httpMethod', '')
    path = event.get('path', '')
    params = event.get('queryStringParameters') or {}
    body = json.loads(event.get('body') or '{}')
    sqs = get_sqs_client()

    try:
        if method == 'OPTIONS':
            return cors_response(200)

        # GET /queues — paginated with search
        if method == 'GET' and path == '/queues':
            page = int(params.get('page', '1'))
            page_size = int(params.get('pageSize', '20'))
            search = (params.get('search') or '').lower()

            # list_queues is fast — just URLs, no attributes
            all_urls = sqs.list_queues().get('QueueUrls', [])
            all_names = [{'name': url.split('/')[-1], 'url': url} for url in all_urls]

            # Filter by search
            if search:
                all_names = [q for q in all_names if search in q['name'].lower()]

            total = len(all_names)

            # Paginate
            start = (page - 1) * page_size
            page_items = all_names[start:start + page_size]

            # Fetch attributes only for the current page
            attrs_to_get = [
                'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible',
                'ApproximateNumberOfMessagesDelayed', 'QueueArn', 'VisibilityTimeout',
                'MessageRetentionPeriod', 'RedrivePolicy', 'FifoQueue',
                'ContentBasedDeduplication', 'CreatedTimestamp', 'LastModifiedTimestamp',
            ]
            queues = []
            for q in page_items:
                try:
                    attr = sqs.get_queue_attributes(QueueUrl=q['url'], AttributeNames=attrs_to_get).get('Attributes', {})
                except Exception as e:
                    logger.warning(
                        "Failed to get queue attributes for %s (attrs=%s): %s",
                        q['url'], attrs_to_get, e, exc_info=True,
                    )
                    attr = {}
                queues.append({'name': q['name'], 'url': q['url'], 'attributes': attr})

            # Enrich DLQ relationships within the page
            arn_to_name = {q['attributes'].get('QueueArn', ''): q['name'] for q in queues}
            for q in queues:
                rp = q['attributes'].get('RedrivePolicy')
                if rp:
                    try:
                        dlq_arn = json.loads(rp).get('deadLetterTargetArn', '')
                        q['dlqName'] = arn_to_name.get(dlq_arn)
                    except Exception:
                        pass
                q['isDeadLetterQueue'] = any(
                    _is_dlq_of(other, q['attributes'].get('QueueArn', ''))
                    for other in queues if other['name'] != q['name']
                )

            return cors_response(200, {
                'queues': queues,
                'total': total,
                'page': page,
                'pageSize': page_size,
            })

        # POST /queues
        if method == 'POST' and path == '/queues':
            name = body['name']
            attrs = body.get('attributes', {})
            if name.endswith('.fifo'):
                attrs.setdefault('FifoQueue', 'true')
            result = sqs.create_queue(QueueName=name, Attributes=attrs)
            return cors_response(201, {'queueUrl': result['QueueUrl']})

        # Match /queues/{queueName}/**
        m = re.match(r'^/queues/([^/]+)(/.*)?$', path)
        if not m:
            return cors_response(404, {'error': 'Not found'})

        queue_name = m.group(1)
        sub_path = m.group(2) or ''

        # Resolve queue URL
        queue_url = sqs.get_queue_url(QueueName=queue_name)['QueueUrl']

        # DELETE /queues/{queueName}
        if method == 'DELETE' and sub_path == '':
            sqs.delete_queue(QueueUrl=queue_url)
            return cors_response(200, {'deleted': queue_name})

        # PUT /queues/{queueName}
        if method == 'PUT' and sub_path == '':
            sqs.set_queue_attributes(QueueUrl=queue_url, Attributes=body.get('attributes', {}))
            return cors_response(200, {'updated': queue_name})

        # POST /queues/{queueName}/purge
        if method == 'POST' and sub_path == '/purge':
            sqs.purge_queue(QueueUrl=queue_url)
            return cors_response(200, {'purged': queue_name})

        # POST /queues/{queueName}/messages
        if method == 'POST' and sub_path == '/messages':
            kwargs = {'QueueUrl': queue_url, 'MessageBody': body['messageBody']}
            if body.get('messageGroupId'):
                kwargs['MessageGroupId'] = body['messageGroupId']
            if body.get('messageDeduplicationId'):
                if not queue_name.endswith('.fifo'):
                    return cors_response(400, {'error': 'messageDeduplicationId is only supported for FIFO queues'})
                kwargs['MessageDeduplicationId'] = body['messageDeduplicationId']
            if body.get('delaySeconds') is not None:
                kwargs['DelaySeconds'] = int(body['delaySeconds'])
            result = sqs.send_message(**kwargs)
            return cors_response(200, {'messageId': result['MessageId']})

        # GET /queues/{queueName}/messages (peek)
        if method == 'GET' and sub_path == '/messages':
            max_msgs = int(params.get('maxMessages', '5'))
            wait = int(params.get('waitTime', '0'))
            result = sqs.receive_message(
                QueueUrl=queue_url, MaxNumberOfMessages=min(max_msgs, 10),
                WaitTimeSeconds=wait, AttributeNames=['All'],
            )
            messages = result.get('Messages', [])
            # Return messages to queue by setting visibility to 0
            for msg in messages:
                sqs.change_message_visibility(QueueUrl=queue_url, ReceiptHandle=msg['ReceiptHandle'], VisibilityTimeout=0)
            return cors_response(200, messages)

        # DELETE /queues/{queueName}/messages
        if method == 'DELETE' and sub_path == '/messages':
            sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=body['receiptHandle'])
            return cors_response(200, {'deleted': True})

        # PUT /queues/{queueName}/messages — atomic edit (delete old + send new)
        if method == 'PUT' and sub_path == '/messages':
            message_body = body.get('messageBody')
            message_id = body.get('messageId')
            if not message_body:
                return cors_response(400, {'error': 'messageBody is required'})
            if not message_id:
                return cors_response(400, {'error': 'messageId is required'})

            # Find the original message by MessageId using a fresh receive, then delete it.
            # Long polling (WaitTimeSeconds > 0) queries all SQS servers, avoiding
            # the random-subset sampling of short polling that can miss messages on
            # busy queues.
            poll_wait = int(os.environ.get('SQS_MOVE_POLL_WAIT_SECONDS', '5'))
            max_attempts = int(os.environ.get('SQS_MOVE_MAX_ATTEMPTS', '5'))
            found = False
            for _ in range(max_attempts):
                batch = sqs.receive_message(
                    QueueUrl=queue_url, MaxNumberOfMessages=10,
                    WaitTimeSeconds=poll_wait, AttributeNames=['All'],
                    MessageAttributeNames=['All'],
                )
                msgs = batch.get('Messages', [])
                if not msgs:
                    continue
                for msg in msgs:
                    if msg['MessageId'] == message_id:
                        original_attributes = msg.get('Attributes', {})
                        original_message_attributes = msg.get('MessageAttributes', {})
                        # Validate FIFO requirements before deleting
                        if queue_name.endswith('.fifo'):
                            effective_group_id = body.get('messageGroupId') or original_attributes.get('MessageGroupId')
                            if not effective_group_id:
                                # Reset visibility for ALL messages in the batch (including this one)
                                for reset_msg in msgs:
                                    sqs.change_message_visibility(QueueUrl=queue_url, ReceiptHandle=reset_msg['ReceiptHandle'], VisibilityTimeout=0)
                                return cors_response(400, {'error': 'messageGroupId is required for FIFO queues and was not found in the request or the original message'})
                        try:
                            sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=msg['ReceiptHandle'])
                            found = True
                        except Exception as e:
                            logger.exception("Edit: failed to delete message")
                            return cors_response(400, {'error': f'Failed to delete original message: {str(e)}'})
                    else:
                        # Return non-matching messages to the queue
                        sqs.change_message_visibility(QueueUrl=queue_url, ReceiptHandle=msg['ReceiptHandle'], VisibilityTimeout=0)
                if found:
                    break
            if not found:
                return cors_response(400, {'error': 'Could not find original message to delete — it may have already been consumed'})

            # Send the new message
            send_kwargs = {'QueueUrl': queue_url, 'MessageBody': message_body}
            if original_message_attributes:
                send_kwargs['MessageAttributes'] = original_message_attributes
            if body.get('messageGroupId'):
                send_kwargs['MessageGroupId'] = body['messageGroupId']
            elif queue_name.endswith('.fifo'):
                send_kwargs['MessageGroupId'] = original_attributes.get('MessageGroupId', 'edit')
            if queue_name.endswith('.fifo'):
                # Always generate a unique dedup ID for edits to avoid SQS 5-minute
                # deduplication window silently dropping the edited message.
                # Strip any previous -edit-* suffixes to prevent unbounded growth.
                dedup = body.get('messageDeduplicationId', '')
                dedup = re.sub(r'(-edit-[0-9a-f]+)+$', '', dedup)
                send_kwargs['MessageDeduplicationId'] = f"{dedup}-edit-{uuid.uuid4().hex[:8]}" if dedup else uuid.uuid4().hex
            # messageDeduplicationId is intentionally NOT sent for standard queues;
            # SQS rejects it with InvalidParameterValue and the original is already deleted.
            try:
                result = sqs.send_message(**send_kwargs)
            except Exception as e:
                logger.exception("Edit partial failure: original deleted but new message send failed")
                return cors_response(500, {'error': f'Original message deleted but re-send failed: {str(e)}'})

            return cors_response(200, {'messageId': result['MessageId']})

        # POST /queues/{queueName}/redrive — move messages from DLQ back to source queue
        if method == 'POST' and sub_path == '/redrive':
            max_msgs = int(body.get('maxMessages', 10))
            # Find source queues that use this DLQ
            try:
                dlq_arn = sqs.get_queue_attributes(QueueUrl=queue_url, AttributeNames=['QueueArn'])['Attributes']['QueueArn']
            except Exception as e:
                return cors_response(403, {'error': f'Cannot get ARN for queue: {str(e)}'})

            all_urls = sqs.list_queues().get('QueueUrls', [])
            source_url = None
            for url in all_urls:
                try:
                    attrs = sqs.get_queue_attributes(QueueUrl=url, AttributeNames=['RedrivePolicy']).get('Attributes', {})
                except Exception as e:
                    logger.debug("Failed to get queue attributes for %s: %s", url, e)
                    continue
                rp = attrs.get('RedrivePolicy')
                if rp:
                    try:
                        if json.loads(rp).get('deadLetterTargetArn') == dlq_arn:
                            source_url = url
                            break
                    except Exception:
                        pass
            if not source_url:
                return cors_response(400, {'error': 'No source queue found for this DLQ'})

            # Check if source is FIFO
            try:
                source_attrs = sqs.get_queue_attributes(QueueUrl=source_url, AttributeNames=['FifoQueue']).get('Attributes', {})
                is_fifo = source_attrs.get('FifoQueue') == 'true'
            except Exception:
                is_fifo = source_url.endswith('.fifo')

            moved = 0
            move_max_attempts = int(os.environ.get('SQS_MOVE_MAX_ATTEMPTS', '5'))
            poll_wait = int(os.environ.get('SQS_MOVE_POLL_WAIT_SECONDS', '5'))
            empty_receives = 0
            while moved < max_msgs:
                batch = sqs.receive_message(QueueUrl=queue_url, MaxNumberOfMessages=min(10, max_msgs - moved), WaitTimeSeconds=poll_wait, AttributeNames=['All'], MessageAttributeNames=['All'])
                msgs = batch.get('Messages', [])
                if not msgs:
                    empty_receives += 1
                    if empty_receives >= move_max_attempts:
                        break
                    continue
                empty_receives = 0
                for msg in msgs:
                    send_kwargs = {'QueueUrl': source_url, 'MessageBody': msg['Body']}
                    msg_msg_attrs = msg.get('MessageAttributes', {})
                    if msg_msg_attrs:
                        send_kwargs['MessageAttributes'] = msg_msg_attrs
                    if is_fifo:
                        send_kwargs['MessageGroupId'] = msg.get('Attributes', {}).get('MessageGroupId', 'redrive')
                        send_kwargs['MessageDeduplicationId'] = msg['MessageId'] + '-redrive'
                    sqs.send_message(**send_kwargs)
                    sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=msg['ReceiptHandle'])
                    moved += 1
            return cors_response(200, {'moved': moved, 'sourceQueue': source_url.split('/')[-1]})

        # POST /queues/{queueName}/messages/batch
        if method == 'POST' and sub_path == '/messages/batch':
            msgs = body.get('messages', [])
            is_fifo = queue_name.endswith('.fifo')
            sent, failed = 0, 0
            for i in range(0, len(msgs), 10):
                entries = []
                for j, m in enumerate(msgs[i:i+10]):
                    entry = {'Id': str(i+j), 'MessageBody': m.get('messageBody', m) if isinstance(m, dict) else str(m)}
                    if is_fifo:
                        entry['MessageGroupId'] = m.get('messageGroupId', 'batch') if isinstance(m, dict) else 'batch'
                        entry['MessageDeduplicationId'] = m.get('messageDeduplicationId', f'batch-{i+j}') if isinstance(m, dict) else f'batch-{i+j}'
                    if isinstance(m, dict) and m.get('delaySeconds') is not None:
                        entry['DelaySeconds'] = int(m['delaySeconds'])
                    entries.append(entry)
                result = sqs.send_message_batch(QueueUrl=queue_url, Entries=entries)
                sent += len(result.get('Successful', []))
                failed += len(result.get('Failed', []))
            return cors_response(200, {'sent': sent, 'failed': failed})

        # POST /queues/{queueName}/export
        if method == 'POST' and sub_path == '/export':
            max_msgs = int(body.get('maxMessages', 100))
            exported = []
            while len(exported) < max_msgs:
                batch = sqs.receive_message(QueueUrl=queue_url, MaxNumberOfMessages=min(10, max_msgs - len(exported)), WaitTimeSeconds=0, AttributeNames=['All'])
                msgs = batch.get('Messages', [])
                if not msgs:
                    break
                for msg in msgs:
                    sqs.change_message_visibility(QueueUrl=queue_url, ReceiptHandle=msg['ReceiptHandle'], VisibilityTimeout=0)
                    exported.append({'messageId': msg['MessageId'], 'body': msg['Body'], 'attributes': msg.get('Attributes', {})})
            return cors_response(200, exported)

        # POST /queues/{queueName}/import
        if method == 'POST' and sub_path == '/import':
            msgs = body.get('messages', [])
            is_fifo = queue_name.endswith('.fifo')
            sent = 0
            for m in msgs:
                kwargs = {'QueueUrl': queue_url, 'MessageBody': m.get('body', m.get('messageBody', ''))}
                if is_fifo:
                    kwargs['MessageGroupId'] = m.get('attributes', {}).get('MessageGroupId', 'import')
                    kwargs['MessageDeduplicationId'] = m.get('messageId', f'import-{sent}') + '-import'
                sqs.send_message(**kwargs)
                sent += 1
            return cors_response(200, {'imported': sent})

        # POST /queues/{queueName}/move
        if method == 'POST' and sub_path == '/move':
            target_name = body.get('targetQueue')
            max_msgs = int(body.get('maxMessages', 100))

            if not target_name:
                return cors_response(400, {'error': 'targetQueue is required'})
            
            target_url = sqs.get_queue_url(QueueName=target_name)['QueueUrl']
            try:
                target_attrs = sqs.get_queue_attributes(QueueUrl=target_url, AttributeNames=['FifoQueue']).get('Attributes', {})
                is_target_fifo = target_attrs.get('FifoQueue') == 'true'
            except Exception:
                is_target_fifo = target_name.endswith('.fifo')

            message_id = body.get('messageId')
            if message_id:
                # Move a single message using a fresh receive to avoid stale receipt handles.
                # The peek endpoint (GET /messages) resets visibility immediately, so the
                # receipt handle returned to the frontend is unreliable by the time the
                # move request arrives.  Re-receive by MessageId to get a fresh handle,
                # matching the pattern used by the edit (PUT /messages) endpoint.
                poll_wait = int(os.environ.get('SQS_MOVE_POLL_WAIT_SECONDS', '5'))
                max_attempts = int(os.environ.get('SQS_MOVE_MAX_ATTEMPTS', '5'))
                found_msg = None
                empty_receives = 0
                for _ in range(max_attempts):
                    batch = sqs.receive_message(
                        QueueUrl=queue_url, MaxNumberOfMessages=10,
                        WaitTimeSeconds=poll_wait, AttributeNames=['All'],
                        MessageAttributeNames=['All'],
                    )
                    msgs = batch.get('Messages', [])
                    if not msgs:
                        empty_receives += 1
                        if empty_receives >= max_attempts:
                            break
                        continue
                    empty_receives = 0
                    for msg in msgs:
                        if msg['MessageId'] == message_id:
                            found_msg = msg
                        else:
                            sqs.change_message_visibility(
                                QueueUrl=queue_url,
                                ReceiptHandle=msg['ReceiptHandle'],
                                VisibilityTimeout=0,
                            )
                    if found_msg:
                        break

                if not found_msg:
                    return cors_response(409, {
                        'error': 'Could not re-receive the message — it may have been consumed or is temporarily invisible',
                    })

                msg_body = found_msg['Body']
                msg_attributes = found_msg.get('Attributes', {})
                fresh_receipt = found_msg['ReceiptHandle']

                send_kwargs = {'QueueUrl': target_url, 'MessageBody': msg_body}
                msg_message_attributes = found_msg.get('MessageAttributes', {})
                if msg_message_attributes:
                    send_kwargs['MessageAttributes'] = msg_message_attributes
                if is_target_fifo:
                    send_kwargs['MessageGroupId'] = msg_attributes.get('MessageGroupId', 'move')
                    send_kwargs['MessageDeduplicationId'] = found_msg['MessageId'] + '-move'

                try:
                    sqs.send_message(**send_kwargs)
                except Exception as e:
                    logger.exception("Move: failed to send message to target queue: %s", e)
                    try:
                        sqs.change_message_visibility(
                            QueueUrl=queue_url,
                            ReceiptHandle=fresh_receipt,
                            VisibilityTimeout=0,
                        )
                    except Exception as vis_err:
                        logger.exception("Move: failed to restore source message visibility: %s", vis_err)
                    return cors_response(500, {
                        'error': f'Failed to send message to target queue: {str(e)}',
                    })

                try:
                    sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=fresh_receipt)
                except Exception as e:
                    logger.exception("Move: sent to target but failed to delete from source: %s", str(e))
                    return cors_response(500, {
                        'error': f'Message sent to target queue but deletion from source failed: {str(e)}',
                    })

                return cors_response(200, {'moved': 1, 'targetQueue': target_name})

            moved = 0
            move_max_attempts = int(os.environ.get('SQS_MOVE_MAX_ATTEMPTS', '5'))
            poll_wait = int(os.environ.get('SQS_MOVE_POLL_WAIT_SECONDS', '5'))
            empty_receives = 0
            while moved < max_msgs:
                batch = sqs.receive_message(QueueUrl=queue_url, MaxNumberOfMessages=min(10, max_msgs - moved), WaitTimeSeconds=poll_wait, AttributeNames=['All'], MessageAttributeNames=['All'])
                msgs = batch.get('Messages', [])
                if not msgs:
                    empty_receives += 1
                    if empty_receives >= move_max_attempts:
                        break
                    continue
                empty_receives = 0
                for msg in msgs:
                    send_kwargs = {'QueueUrl': target_url, 'MessageBody': msg['Body']}
                    msg_msg_attrs = msg.get('MessageAttributes', {})
                    if msg_msg_attrs:
                        send_kwargs['MessageAttributes'] = msg_msg_attrs
                    if is_target_fifo:
                        send_kwargs['MessageGroupId'] = msg.get('Attributes', {}).get('MessageGroupId', 'move')
                        send_kwargs['MessageDeduplicationId'] = msg['MessageId'] + '-move'
                    sqs.send_message(**send_kwargs)
                    sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=msg['ReceiptHandle'])
                    moved += 1
            return cors_response(200, {'moved': moved, 'targetQueue': target_name})

        return cors_response(404, {'error': 'Not found'})

    except Exception as e:
        return cors_response(500, {'error': str(e)})
