// Package dynamodb implements pushstore.Store. Same single-table shape as
// invitestore/dynamodb: PK = pushRoutingId, SK splits prefs from device rows.
//
// No TTL, unlike the invite table: a routing id is how a device stays
// reachable between posts, not a handoff that expires.
package dynamodb

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/storage/dynamoutil"
	"circle-relay/internal/storage/pushstore"
)

const (
	prefsSK        = "prefs"
	deviceSKPrefix = "device#"
)

func deviceSK(deviceID string) string {
	return deviceSKPrefix + deviceID
}

type Store struct {
	client    *dynamodb.Client
	tableName string
}

func New(client *dynamodb.Client, tableName string) *Store {
	return &Store{client: client, tableName: tableName}
}

var _ pushstore.Store = (*Store)(nil)

func (s *Store) PutPrefs(ctx context.Context, pushRoutingID string, prefs pushstore.Prefs) error {
	_, err := s.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.tableName),
		Item: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: pushRoutingID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: prefsSK},
			"pushFanoutHash":  &types.AttributeValueMemberB{Value: prefs.PushFanoutHash},
			"categoryMask":    &types.AttributeValueMemberN{Value: strconv.FormatInt(prefs.CategoryMask, 10)},
			"keyVersion":      &types.AttributeValueMemberN{Value: strconv.FormatInt(prefs.KeyVersion, 10)},
		},
	})
	if err != nil {
		return fmt.Errorf("put push prefs: %w", err)
	}
	return nil
}

func (s *Store) GetPrefs(ctx context.Context, pushRoutingID string) (*pushstore.Prefs, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: pushRoutingID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: prefsSK},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("get push prefs: %w", err)
	}
	if out.Item == nil {
		return nil, pushstore.ErrPushRoutingNotFound
	}

	// A row missing these wasn't written by this code — reading it as
	// zeroes would authorize an empty token.
	pushFanoutHash, ok := dynamoutil.AttrBytes(out.Item, "pushFanoutHash")
	if !ok {
		return nil, fmt.Errorf("push prefs row for %q has no pushFanoutHash", pushRoutingID)
	}
	categoryMask, err := dynamoutil.AttrInt(out.Item, "categoryMask")
	if err != nil {
		return nil, fmt.Errorf("push prefs row for %q: %w", pushRoutingID, err)
	}
	keyVersion, err := dynamoutil.AttrInt(out.Item, "keyVersion")
	if err != nil {
		return nil, fmt.Errorf("push prefs row for %q: %w", pushRoutingID, err)
	}

	prefs := pushstore.Prefs{
		PushFanoutHash: pushFanoutHash,
		CategoryMask:   categoryMask,
		KeyVersion:     keyVersion,
	}
	return &prefs, nil
}

func (s *Store) PutDevice(ctx context.Context, pushRoutingID string, device pushstore.Device) error {
	_, err := s.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.tableName),
		Item: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: pushRoutingID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: deviceSK(device.DeviceID)},
			"pushToken":       &types.AttributeValueMemberB{Value: device.PushToken},
			"platform":        &types.AttributeValueMemberS{Value: device.Platform},
			"enabled":         &types.AttributeValueMemberBOOL{Value: device.Enabled},
		},
	})
	if err != nil {
		return fmt.Errorf("put push device: %w", err)
	}
	return nil
}

func (s *Store) ListDevices(ctx context.Context, pushRoutingID string) ([]pushstore.Device, error) {
	out, err := s.client.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(s.tableName),
		KeyConditionExpression: aws.String(fmt.Sprintf("%s = :pk AND begins_with(%s, :prefix)", dynamoutil.PKAttr, dynamoutil.SKAttr)),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     &types.AttributeValueMemberS{Value: pushRoutingID},
			":prefix": &types.AttributeValueMemberS{Value: deviceSKPrefix},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("list push devices: %w", err)
	}

	devices := make([]pushstore.Device, 0, len(out.Items))
	for _, item := range out.Items {
		sk, ok := dynamoutil.AttrString(item, dynamoutil.SKAttr)
		if !ok {
			continue
		}
		pushToken, ok := dynamoutil.AttrBytes(item, "pushToken")
		if !ok {
			continue
		}
		platform, _ := dynamoutil.AttrString(item, "platform")
		devices = append(devices, pushstore.Device{
			DeviceID:  strings.TrimPrefix(sk, deviceSKPrefix),
			PushToken: pushToken,
			Platform:  platform,
			Enabled:   dynamoutil.AttrBool(item, "enabled"),
		})
	}
	return devices, nil
}

func (s *Store) DeleteDevice(ctx context.Context, pushRoutingID, deviceID string) error {
	_, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: pushRoutingID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: deviceSK(deviceID)},
		},
	})
	if err != nil {
		return fmt.Errorf("delete push device: %w", err)
	}
	return nil
}

// Not transactional. A partial failure orphans device rows, which is
// harmless: a send reads prefs first, so they're already unreachable.
func (s *Store) DeleteRouting(ctx context.Context, pushRoutingID string) error {
	devices, err := s.ListDevices(ctx, pushRoutingID)
	if err != nil {
		return err
	}

	var errs []error
	for _, device := range devices {
		if err := s.DeleteDevice(ctx, pushRoutingID, device.DeviceID); err != nil {
			errs = append(errs, err)
		}
	}

	_, err = s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: pushRoutingID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: prefsSK},
		},
	})
	if err != nil {
		errs = append(errs, fmt.Errorf("delete push prefs: %w", err))
	}
	return errors.Join(errs...)
}
