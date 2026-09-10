package dynamoutil_test

import (
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/storage/dynamoutil"
)

func TestAttrBytes(t *testing.T) {
	item := map[string]types.AttributeValue{
		"blob": &types.AttributeValueMemberB{Value: []byte("hello")},
		"text": &types.AttributeValueMemberS{Value: "not binary"},
	}

	got, ok := dynamoutil.AttrBytes(item, "blob")
	if !ok || string(got) != "hello" {
		t.Fatalf("expected hello, got %q ok=%v", got, ok)
	}

	// A wrongly-typed attribute reports absent rather than panicking on the
	// type assertion — callers treat missing as skippable.
	if _, ok := dynamoutil.AttrBytes(item, "text"); ok {
		t.Fatal("a String attribute must not read as Binary")
	}
	if _, ok := dynamoutil.AttrBytes(item, "absent"); ok {
		t.Fatal("a missing attribute must report absent")
	}
}

func TestAttrBool(t *testing.T) {
	item := map[string]types.AttributeValue{
		"yes":    &types.AttributeValueMemberBOOL{Value: true},
		"no":     &types.AttributeValueMemberBOOL{Value: false},
		"number": &types.AttributeValueMemberN{Value: "1"},
	}

	if !dynamoutil.AttrBool(item, "yes") {
		t.Fatal("expected true")
	}
	if dynamoutil.AttrBool(item, "no") {
		t.Fatal("expected false")
	}
	// Both fall back to false: a row written before a flag existed has not
	// opted into it.
	if dynamoutil.AttrBool(item, "number") {
		t.Fatal("a Number attribute must not read as true")
	}
	if dynamoutil.AttrBool(item, "absent") {
		t.Fatal("a missing attribute must read as false")
	}
}

func TestAttrString(t *testing.T) {
	item := map[string]types.AttributeValue{
		"text":   &types.AttributeValueMemberS{Value: "value"},
		"number": &types.AttributeValueMemberN{Value: "7"},
	}

	if got, ok := dynamoutil.AttrString(item, "text"); !ok || got != "value" {
		t.Fatalf("expected value, got %q ok=%v", got, ok)
	}
	if _, ok := dynamoutil.AttrString(item, "number"); ok {
		t.Fatal("a Number attribute must not read as String")
	}
	if _, ok := dynamoutil.AttrString(item, "absent"); ok {
		t.Fatal("a missing attribute must report absent")
	}
}

func TestAttrInt(t *testing.T) {
	item := map[string]types.AttributeValue{
		"number":  &types.AttributeValueMemberN{Value: "42"},
		"text":    &types.AttributeValueMemberS{Value: "42"},
		"garbage": &types.AttributeValueMemberN{Value: "not-a-number"},
	}

	got, err := dynamoutil.AttrInt(item, "number")
	if err != nil || got != 42 {
		t.Fatalf("expected 42, got %d err=%v", got, err)
	}
	// Unlike the others this errors rather than reporting absence — its
	// callers treat a missing number as a corrupt row, not a skippable one.
	for _, key := range []string{"text", "garbage", "absent"} {
		if _, err := dynamoutil.AttrInt(item, key); err == nil {
			t.Fatalf("expected an error for %q", key)
		}
	}
}
